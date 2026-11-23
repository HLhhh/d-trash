import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isCanonicalPath } from './fs-retry.js';
// Fixed policy, independent of the Host environment. KEEP counts archives,
// in addition to the active file. A whole record may overshoot MAX_BYTES.
export const MAX_BYTES = 4 * 1024 * 1024;
export const KEEP = 3;
// Share queues across service instances in this process. O_APPEND prevents
// overwrite; rotation never truncates a file, including an already-open inode.
const writers = new Map();
const describe = (reason) => {
    try {
        return String(reason);
    }
    catch {
        return 'Unprintable operation error';
    }
};
const regular = async (file) => {
    const info = await lstat(file, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    });
    if (info && (!info.isFile() || !await isCanonicalPath(file))) {
        throw new Error(`Operation log must be a canonical regular file: ${file}`);
    }
    return info;
};
const rotationRecord = (stage, result, reason) => ({
    ts: new Date().toISOString(), action: 'log-rotate', sessionId: null, stage, result, reason,
});
/** Best effort only: neither discovery, I/O, nor the fallback logger may throw. */
export class OperationLog {
    locateHome;
    fallback;
    home;
    constructor(locateHome, fallback) {
        this.locateHome = locateHome;
        this.fallback = fallback;
    }
    /** Capture stat's home before a purge can rename/remove its source. */
    async prepare(id) {
        try {
            this.home ??= await this.locateHome(id);
        }
        catch { /* write retries and reports the failure */ }
    }
    degrade(record, error) {
        try {
            this.fallback(JSON.stringify({ ...record, logError: describe(error) }));
        }
        catch { /* best effort */ }
    }
    async append(file, record) {
        const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
        // Other processes can rename/create the active path between lstat/open.
        // Retry only before writing, so a successful append is never duplicated.
        for (let attempt = 0;; attempt++) {
            try {
                const before = await regular(file);
                const posixFlags = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
                const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
                    | (before ? 0 : constants.O_EXCL) | posixFlags, 0o600);
                try {
                    const held = await handle.stat({ bigint: true });
                    const current = await regular(file);
                    if (!held.isFile() || !current || held.ino !== current.ino || held.dev !== current.dev) {
                        const error = new Error('Operation log identity changed');
                        error.code = 'ELOGMOVED';
                        throw error;
                    }
                    await handle.chmod(0o600);
                    // One write per JSONL record: do not split large records into the
                    // appendFile helper's chunks, which other processes could interleave.
                    const { bytesWritten } = await handle.write(line);
                    if (bytesWritten !== line.length)
                        throw new Error('Incomplete operation log write');
                }
                finally {
                    await handle.close();
                }
                return;
            }
            catch (error) {
                if (attempt >= 24 || !['ENOENT', 'EEXIST', 'ELOGMOVED'].includes(error.code ?? ''))
                    throw error;
                await setTimeout(20);
            }
        }
    }
    async rotate(file) {
        const before = await regular(file);
        if (!before || before.size <= BigInt(MAX_BYTES))
            return;
        // Only rotation needs this cooperative cross-process guard. Appends may
        // still finish through old handles after rename, so this is NOT a
        // cross-process append/rotation transaction. Never steal a stale guard.
        const guard = `${file}.rotate`;
        let acquired = false;
        let stage = 'guard';
        try {
            for (let attempt = 0;; attempt++) {
                try {
                    await mkdir(guard, { mode: 0o700 });
                    acquired = true;
                    break;
                }
                catch (error) {
                    if (error.code !== 'EEXIST' || attempt >= 24)
                        throw error;
                    await setTimeout(20);
                }
            }
            // A competing rotator may already have replaced the oversized file.
            const current = await regular(file);
            if (!current || current.size <= BigInt(MAX_BYTES))
                return;
            // Validate ALL archive paths before deleting or renaming anything.
            stage = 'validate';
            for (let i = 1; i <= KEEP; i++)
                await regular(`${file}.${i}`);
            stage = `delete:${KEEP}`;
            const oldest = await regular(`${file}.${KEEP}`);
            if (oldest)
                await unlink(`${file}.${KEEP}`);
            for (let i = KEEP - 1; i >= 0; i--) {
                const source = i === 0 ? file : `${file}.${i}`;
                stage = `rename:${i}->${i + 1}`;
                if (await regular(source))
                    await rename(source, `${file}.${i + 1}`);
            }
            stage = 'create:0';
            await this.append(file, rotationRecord('complete', 'ok', `trash.log -> trash.log.1; archives=1..${KEEP}; evicted=${oldest ? `trash.log.${KEEP}` : 'none'}; MAX_BYTES=${MAX_BYTES}`));
        }
        catch (error) {
            this.degrade(rotationRecord(stage, 'failed', `archives=1..${KEEP}; ${describe(error)}`), error);
            throw error;
        }
        finally {
            if (acquired) {
                try {
                    await rmdir(guard);
                }
                catch (error) {
                    this.degrade(rotationRecord('guard-release', 'failed', guard), error);
                    throw error;
                }
            }
        }
    }
    async write(action, sessionId, stage, result, reason = null) {
        const record = { ts: new Date().toISOString(), action, sessionId, stage, result,
            reason: reason === null || reason === undefined ? null : describe(reason) };
        try {
            this.home ??= await this.locateHome(sessionId ?? undefined);
            const home = this.home;
            const file = join(home, 'logs', 'trash.log');
            const previous = writers.get(file) ?? Promise.resolve();
            const writing = previous.then(async () => {
                if (!await isCanonicalPath(home))
                    throw new Error('Unsafe operation log home');
                const directory = join(home, 'logs');
                await mkdir(directory, { recursive: true, mode: 0o700 });
                if (!await isCanonicalPath(directory) || !(await lstat(directory)).isDirectory()) {
                    throw new Error('Unsafe operation log directory');
                }
                await this.rotate(file);
                await this.append(file, record);
            });
            const settled = writing.catch(() => { });
            writers.set(file, settled);
            try {
                await writing;
            }
            finally {
                if (writers.get(file) === settled)
                    writers.delete(file);
            }
        }
        catch (error) {
            this.degrade(record, error);
        }
    }
}
