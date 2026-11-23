import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
/** Exactly the JSONL backend's Win32 namespace and path normalization. */
export const semaphoreName = (path) => `Local\\dsh-session-lock-${createHash('sha256').update(resolve(path).toLowerCase()).digest('hex')}`;
const busy = () => Object.assign(new Error('Session lock is busy; session may be open or writing'), { code: 'EBUSY' });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
/** Native backend-compatible exclusion, never a plugin-only directory lock.
 * Official lease.ts cannot be imported by Electron: TS stripping under
 * node_modules is unsupported. POSIX keeps the stricter existing-file open;
 * Windows uses the backend's count-1 semaphore (no filesystem footprint).
 */
export async function acquireWriteLease(directory, allowMissing = false) {
    const path = join(directory, 'session.lock');
    if (process.platform === 'win32') {
        const koffi = (await import('koffi')).default;
        const api = koffi.load('kernel32.dll');
        const create = api.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']);
        const wait = api.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']);
        const release = api.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']);
        const close = api.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
        const lastError = api.func('__stdcall', 'GetLastError', 'uint', []);
        const failure = (operation, code) => new Error(`${operation} failed (Win32 ${code})`);
        const handle = create(null, 1, 1, semaphoreName(path));
        if (!handle)
            throw failure('CreateSemaphoreW', lastError());
        const result = wait(handle, 0);
        if (result !== 0) {
            const code = lastError();
            close(handle);
            if (result === 0x102)
                throw busy();
            throw failure('WaitForSingleObject', code);
        }
        let released = false;
        return {
            async verify() { if (released)
                throw new Error('Write lease was released'); },
            async release() {
                if (released)
                    return;
                released = true;
                const restored = release(handle, 1, null);
                const code = restored ? 0 : lastError();
                const closed = close(handle);
                if (!restored || !closed)
                    throw failure('ReleaseSemaphore/CloseHandle', code || lastError());
            },
        };
    }
    const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW).catch(error => {
        if (allowMissing && error.code === 'ENOENT')
            return undefined;
        throw error;
    });
    // Only a durable partial-rm receipt permits an absent staged POSIX lock.
    if (!handle)
        return { async verify() { }, async release() { } };
    try {
        const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
        await tryLockExclusive(handle.fd);
        const held = await handle.stat({ bigint: true });
        const verify = async () => {
            const current = await lstat(path, { bigint: true });
            if (!held.isFile() || !current.isFile() || !same(held, current))
                throw new Error('Lock inode changed');
        };
        await verify();
        return { verify, release: () => handle.close() };
    }
    catch (error) {
        await handle.close();
        if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code ?? ''))
            throw busy();
        throw error;
    }
}
