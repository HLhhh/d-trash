import { lstat, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NativeSystemTrash } from './system-trash.js';
import { acquireWriteLease } from './write-lease.js';
import { TrashErrorCode, SESSION_LOCK_BUSY_PREFIX } from './types.js';
import { retrySharing, isCanonicalPath } from './fs-retry.js';
export class PurgeError extends Error {
    sessionId;
    stage;
    code;
    constructor(sessionId, stage, cause, code) {
        super(`${code === TrashErrorCode.SessionLockBusy ? SESSION_LOCK_BUSY_PREFIX : ''}Move to system trash [${stage}] (${sessionId}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.sessionId = sessionId;
        this.stage = stage;
        this.code = code;
    }
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const missing = (error) => error?.code === 'ENOENT';
/** JSONL maintenance. Never creates/truncates/unlinks a live POSIX lock file. */
export class SessionPurger {
    observe;
    report;
    systemTrash;
    constructor(observe, report = async () => { }, systemTrash = new NativeSystemTrash()) {
        this.observe = observe;
        this.report = report;
        this.systemTrash = systemTrash;
    }
    /** Shared authority for operation logs; no environment-variable fallback. */
    async home(id) {
        const located = await this.locate(id);
        if (!located)
            throw new Error('No stat-derived home for absent session');
        return located.home;
    }
    async homeFromSource(source) { return (await this.roots(source)).home; }
    /** Derive from stat's source, or its durable receipt after the source is gone.
     * DSH_HOME is a shell hint, not the Host's persistence location authority.
     */
    async roots(source) {
        const root = dirname(dirname(source));
        const home = dirname(root);
        const parts = relative(root, source).split(sep);
        if (!isAbsolute(source) || source !== resolve(source) || basename(root) !== 'sessions'
            || parts.length !== 2 || parts.some(part => !part || part === '..' || part.startsWith('.'))) {
            throw new Error('Session path is outside sessions root or has an unsafe directory identity');
        }
        if (!await isCanonicalPath(home))
            throw new Error('DSH home must not be a symlink');
        if (!await isCanonicalPath(root))
            throw new Error('Sessions root must not be a symlink');
        // JSONL discovery treats every root child directory (including dot dirs) as
        // a project, then every project child directory as a session. Keep renamed
        // sessions outside that tree, including while recovering from a crash.
        return { home, root, staging: join(home, 'sessions.trash-purge-staging') };
    }
    async locate(id) {
        // Only an explicit undefined is absence. Observation/I/O errors and invalid
        // snapshots must propagate; neither authorizes record-only cleanup.
        const snapshot = await this.observe(id);
        if (snapshot === undefined)
            return undefined;
        if (!snapshot || snapshot.header.id !== id || snapshot.location?.kind !== 'jsonl'
            || !isAbsolute(snapshot.location.path))
            throw new Error('No reliable JSONL session location/identity');
        const log = resolve(snapshot.location.path);
        const source = dirname(log);
        const roots = await this.roots(source);
        if (!(await lstat(dirname(source))).isDirectory())
            throw new Error('Session project must not be a symlink');
        if (!await isCanonicalPath(source) || !await isCanonicalPath(log)) {
            throw new Error('Session path is outside sessions root or has an unsafe directory identity');
        }
        const identity = await lstat(source, { bigint: true });
        if (!identity.isDirectory() || identity.ino === 0n || !(await lstat(log)).isFile())
            throw new Error('Invalid session directory/artifact');
        return { ...roots, source, log, identity };
    }
    /** Write lease → recheck → durable intent → final gate → whole-directory system trash move → close. */
    async move(id, gate, save) {
        let stage = 'gate';
        try {
            gate();
            const before = await this.locate(id);
            if (!before) {
                // Native unarchive can interleave while stat is awaiting. No directory
                // or receipt is invented for a ghost; recheck before record cleanup.
                gate();
                return 'logs-absent';
            }
            await this.report(id, 'gate');
            stage = 'lock';
            let acquired;
            try {
                const lease = acquired = await acquireWriteLease(before.source);
                await this.report(id, 'locked');
                stage = 'recheck';
                await lease.verify();
                const after = await this.locate(id);
                if (!after || after.source !== before.source || after.log !== before.log || !same(after.identity, before.identity)) {
                    throw new Error('Session directory identity changed');
                }
                gate();
                await this.report(id, 'recheck');
                const intent = { source: before.source, moving: true,
                    dev: String(before.identity.dev), ino: String(before.identity.ino) };
                stage = 'intent';
                await save(intent);
                await this.report(id, 'intent');
                stage = 'moved-to-trash';
                await retrySharing(() => this.systemTrash.move(before.source, before.identity, async () => {
                    stage = 'recheck';
                    const final = await this.locate(id);
                    if (!final || final.source !== before.source || final.log !== before.log || !same(final.identity, before.identity)
                        || !same(before.identity, await lstat(before.source, { bigint: true })))
                        throw new Error('Directory identity changed before move');
                    await lease.verify();
                    gate();
                    stage = 'moved-to-trash';
                }));
                stage = 'moved-to-trash';
                await this.assertAbsent(before.source);
                await this.report(id, 'moved-to-trash');
                return 'moved';
            }
            finally {
                // POSIX closes the inode moved by rename; Windows releases the original
                // path-named semaphore. Neither branch unlinks a held lock.
                if (acquired) {
                    await acquired.release();
                    await this.report(id, 'unlocked');
                }
            }
        }
        catch (error) {
            const code = error?.code;
            if (stage === 'lock' && (code === 'EBUSY' || code === 'EAGAIN' || code === 'EWOULDBLOCK')) {
                throw new PurgeError(id, 'lock', new Error('Session lock is busy; session may be open or writing', { cause: error }), TrashErrorCode.SessionLockBusy);
            }
            throw new PurgeError(id, stage, error);
        }
    }
    async assertAbsent(source) {
        try {
            await lstat(source);
        }
        catch (error) {
            if (missing(error))
                return;
            throw error;
        }
        throw new Error('Move did not remove the source directory');
    }
    /** New receipts use source presence only; the OS destination is not authority. */
    async deleteStaged(id, intent, save) {
        const { home, staging } = await this.roots(intent.source);
        const source = await lstat(intent.source, { bigint: true }).catch(error => { if (missing(error))
            return undefined; throw error; });
        if (!('target' in intent)) {
            if (intent.moving !== true)
                throw new Error('Unsafe persisted move intent');
            if (source) {
                if (!source.isDirectory() || !await isCanonicalPath(intent.source)
                    || String(source.dev) !== intent.dev || String(source.ino) !== intent.ino)
                    throw new Error('Source was replaced during move');
                return { status: 'unmoved', home };
            }
            return { status: 'deleted', home };
        }
        // Legacy receipts remain bounded to the original sibling staging path.
        if (intent.target !== resolve(intent.target) || dirname(intent.target) !== staging
            || !basename(intent.target).startsWith(`${encodeURIComponent(id)}-`))
            throw new Error('Unsafe persisted purge intent');
        const target = await lstat(intent.target, { bigint: true }).catch(error => { if (missing(error))
            return undefined; throw error; });
        if (source) {
            if (!source.isDirectory() || !await isCanonicalPath(intent.source) || target
                || String(source.dev) !== intent.dev || String(source.ino) !== intent.ino)
                throw new Error('Source was replaced during purge');
            return { status: 'unmoved', home };
        }
        if (!target) {
            if (!intent.moving && !intent.deleting && !intent.logsDeleted)
                throw new Error('Purge intent has no move/deletion evidence');
            return { status: 'deleted', home };
        }
        const verify = async () => {
            if (!target.isDirectory() || String(target.dev) !== intent.dev || String(target.ino) !== intent.ino
                || !await isCanonicalPath(staging) || !await isCanonicalPath(intent.target)
                || !same(target, await lstat(intent.target, { bigint: true })))
                throw new Error('Staged directory identity changed');
            await this.assertAbsent(intent.source);
        };
        await verify();
        const sourceLease = process.platform === 'win32' ? await acquireWriteLease(intent.source) : undefined;
        try {
            const lease = await acquireWriteLease(intent.target, intent.deleting);
            try {
                await lease.verify();
                await verify();
                intent.moving = true;
                await save(intent);
                await this.report(id, 'intent');
                await retrySharing(() => this.systemTrash.move(intent.target, target, async () => {
                    await verify();
                    await lease.verify();
                }));
                await this.assertAbsent(intent.target);
                await this.report(id, 'moved-to-trash');
            }
            finally {
                await lease.release();
                await this.report(id, 'unlocked');
            }
        }
        finally {
            await sourceLease?.release();
        }
        return { status: 'deleted', home };
    }
    async clearProjection(id, home) {
        if (!isAbsolute(home) || home !== resolve(home) || !await isCanonicalPath(home))
            throw new Error('Unsafe projection cache home');
        if (!id || /[/\\]/.test(id) || id === '.' || id === '..')
            throw new Error('Unsafe projection cache key');
        const parent = join(home, 'storages', 'session_projcache', 'sessions');
        try {
            if (!await isCanonicalPath(parent))
                throw new Error('Unsafe projection cache directory');
            await rm(join(parent, `${id}.json`), { force: true });
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
    }
}
