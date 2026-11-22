import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
export class PurgeError extends Error {
    sessionId;
    stage;
    constructor(sessionId, stage, cause) {
        super(`Physical deletion [${stage}] (${sessionId}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.sessionId = sessionId;
        this.stage = stage;
    }
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const missing = (error) => error?.code === 'ENOENT';
/** POSIX maintenance only. Never creates/truncates/unlinks a live lock file. */
export class SessionPurger {
    observe;
    report;
    constructor(observe, report = async () => { }) {
        this.observe = observe;
        this.report = report;
    }
    /** Shared authority for operation logs; no environment-variable fallback. */
    async home(id) { return (await this.locate(id)).home; }
    async homeFromSource(source) { return (await this.roots(source)).home; }
    /** Derive from stat's source, or its durable receipt after the source is gone.
     * DSH_HOME is a shell hint, not the Host's persistence location authority.
     */
    async roots(source) {
        if (process.platform === 'win32')
            throw new Error('POSIX flock is required');
        const root = dirname(dirname(source));
        const home = dirname(root);
        const parts = relative(root, source).split(sep);
        if (!isAbsolute(source) || source !== resolve(source) || basename(root) !== 'sessions'
            || parts.length !== 2 || parts.some(part => !part || part === '..' || part.startsWith('.'))) {
            throw new Error('Session path is outside sessions root or has an unsafe directory identity');
        }
        if (await realpath(home) !== home)
            throw new Error('DSH home must not be a symlink');
        if (await realpath(root) !== root)
            throw new Error('Sessions root must not be a symlink');
        // JSONL discovery treats every root child directory (including dot dirs) as
        // a project, then every project child directory as a session. Keep renamed
        // sessions outside that tree, including while recovering from a crash.
        return { home, root, staging: join(home, 'sessions.trash-purge-staging') };
    }
    async locate(id) {
        const snapshot = await this.observe(id);
        if (!snapshot || snapshot.header.id !== id || snapshot.location?.kind !== 'jsonl'
            || !isAbsolute(snapshot.location.path))
            throw new Error('No reliable JSONL session location/identity');
        const log = resolve(snapshot.location.path);
        const source = dirname(log);
        const roots = await this.roots(source);
        if (await realpath(source) !== source || await realpath(log) !== log) {
            throw new Error('Session path is outside sessions root or has an unsafe directory identity');
        }
        const identity = await lstat(source, { bigint: true });
        if (!identity.isDirectory() || !(await lstat(log)).isFile())
            throw new Error('Invalid session directory/artifact');
        return { ...roots, source, log, identity };
    }
    /** flock → recheck → durable intent → final gate → whole-directory rename → close. */
    async move(id, gate, save) {
        let stage = 'gate';
        try {
            gate();
            const before = await this.locate(id);
            await this.report(id, 'gate');
            stage = 'lock';
            const lockPath = join(before.source, 'session.lock');
            const handle = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
            try {
                await tryLockExclusive(handle.fd);
                await this.report(id, 'locked');
                stage = 'recheck';
                const locked = await handle.stat({ bigint: true });
                if (!locked.isFile() || !same(locked, await lstat(lockPath, { bigint: true })))
                    throw new Error('Lock inode changed');
                const after = await this.locate(id);
                if (after.source !== before.source || after.log !== before.log || !same(after.identity, before.identity)) {
                    throw new Error('Session directory identity changed');
                }
                gate();
                await this.report(id, 'recheck');
                const { staging } = after;
                await mkdir(staging, { recursive: true, mode: 0o700 });
                if (await realpath(staging) !== staging || !(await lstat(staging)).isDirectory())
                    throw new Error('Unsafe staging directory');
                if ((await lstat(staging, { bigint: true })).dev !== before.identity.dev)
                    throw new Error('Staging is on another filesystem');
                const intent = { source: before.source,
                    target: join(staging, `${encodeURIComponent(id)}-${randomUUID()}`),
                    dev: String(before.identity.dev), ino: String(before.identity.ino), logsDeleted: false, deleting: false };
                stage = 'intent';
                await save(intent);
                await this.report(id, 'intent');
                stage = 'recheck';
                const final = await this.locate(id);
                if (final.source !== before.source || final.log !== before.log || !same(final.identity, before.identity)
                    || await realpath(staging) !== staging
                    || !same(before.identity, await lstat(before.source, { bigint: true }))
                    || !same(locked, await lstat(lockPath, { bigint: true })))
                    throw new Error('Directory/lock identity changed before rename');
                gate();
                stage = 'rename';
                await rename(before.source, intent.target);
                await this.report(id, 'renamed');
                return intent;
            }
            finally {
                // This closes the very inode moved by rename. No unlink while held.
                await handle.close();
                await this.report(id, 'unlocked');
            }
        }
        catch (error) {
            const code = error?.code;
            if (stage === 'lock' && (code === 'EAGAIN' || code === 'EWOULDBLOCK')) {
                throw new PurgeError(id, 'lock', new Error('Session lock is busy; session may be open or writing', { cause: error }));
            }
            throw new PurgeError(id, stage, error);
        }
    }
    /** Resume only marker intents targeting the sibling staging; never sweep unknown directories. */
    async deleteStaged(id, intent, save) {
        // stat may no longer find the log after rename/partial rm. The source was
        // captured from stat before rename; validate it again without requiring it
        // to exist, then bind the target to that exact home's sibling staging.
        const { home, staging } = await this.roots(intent.source);
        if (!isAbsolute(intent.source) || intent.source !== resolve(intent.source) || intent.target !== resolve(intent.target)
            || dirname(intent.target) !== staging || !basename(intent.target).startsWith(`${encodeURIComponent(id)}-`)) {
            throw new Error('Unsafe persisted purge intent');
        }
        const source = await lstat(intent.source, { bigint: true }).catch(error => { if (missing(error))
            return undefined; throw error; });
        const target = await lstat(intent.target, { bigint: true }).catch(error => { if (missing(error))
            return undefined; throw error; });
        if (source) {
            if (await realpath(intent.source) !== intent.source || target || String(source.dev) !== intent.dev || String(source.ino) !== intent.ino)
                throw new Error('Source was replaced during purge');
            return { status: 'unmoved', home };
        }
        if (!target) {
            // A recorded rename plus a completed rm can precede the domain commit.
            // The intent remains the receipt for idempotent record cleanup.
            if (!intent.deleting && !intent.logsDeleted)
                throw new Error('Purge intent has no rename/deletion evidence');
            return { status: 'deleted', home };
        }
        if (!target.isDirectory() || String(target.dev) !== intent.dev || String(target.ino) !== intent.ino
            || await realpath(staging) !== staging || await realpath(intent.target) !== intent.target)
            throw new Error('Staged directory identity changed');
        const handle = await open(join(intent.target, 'session.lock'), constants.O_RDWR | constants.O_NOFOLLOW)
            .catch(error => { if (missing(error) && intent.deleting)
            return undefined; throw error; });
        if (handle)
            try {
                await tryLockExclusive(handle.fd);
                const held = await handle.stat({ bigint: true });
                if (!same(held, await lstat(join(intent.target, 'session.lock'), { bigint: true })))
                    throw new Error('Staged lock inode changed');
            }
            finally {
                await handle.close();
            }
        intent.deleting = true;
        await save(intent);
        await this.removeDirectory(intent.target);
        await this.report(id, 'logs-deleted');
        return { status: 'deleted', home };
    }
    /** Separate method permits failure/crash injection in isolated fixtures. */
    async removeDirectory(target) { await rm(target, { recursive: true }); }
    async clearProjection(id, home) {
        if (!isAbsolute(home) || home !== resolve(home) || await realpath(home) !== home)
            throw new Error('Unsafe projection cache home');
        if (!id || /[/\\]/.test(id) || id === '.' || id === '..')
            throw new Error('Unsafe projection cache key');
        const parent = join(home, 'storages', 'session_projcache', 'sessions');
        try {
            if (await realpath(parent) !== parent)
                throw new Error('Unsafe projection cache directory');
            await rm(join(parent, `${id}.json`), { force: true });
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
    }
}
