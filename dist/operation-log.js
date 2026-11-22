import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
// Share queues across service instances in this process; O_APPEND also keeps
// independent processes from overwriting each other's existing bytes.
const writers = new Map();
const describe = (reason) => {
    try {
        return String(reason);
    }
    catch {
        return 'Unprintable operation error';
    }
};
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
    async write(action, sessionId, stage, result, reason = null) {
        const record = { ts: new Date().toISOString(), action, sessionId, stage, result,
            reason: reason === null || reason === undefined ? null : describe(reason) };
        const line = JSON.stringify(record) + '\n';
        try {
            this.home ??= await this.locateHome(sessionId ?? undefined);
            const home = this.home;
            const file = join(home, 'logs', 'trash.log');
            const previous = writers.get(file) ?? Promise.resolve();
            const writing = previous.then(async () => {
                if (await realpath(home) !== home)
                    throw new Error('Unsafe operation log home');
                const directory = join(home, 'logs');
                await mkdir(directory, { recursive: true, mode: 0o700 });
                if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
                    throw new Error('Unsafe operation log directory');
                }
                const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
                    | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
                try {
                    if (!(await handle.stat()).isFile())
                        throw new Error('Operation log must be a regular file');
                    await handle.chmod(0o600);
                    await handle.appendFile(line, 'utf8');
                }
                finally {
                    await handle.close();
                }
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
            try {
                this.fallback(JSON.stringify({ ...record, logError: String(error) }));
            }
            catch { /* best effort */ }
        }
    }
}
