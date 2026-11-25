import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCanonicalPath } from './fs-retry.js';
export function requireSameDevice(source, destination) {
    if (source.dev !== destination.dev)
        throw Object.assign(new Error('System trash is on another volume; copying is not supported'), { code: 'EXDEV' });
}
/** Native bindings are lazy; unsupported platforms never load an FFI library. */
export class NativeSystemTrash {
    platform;
    userHome;
    constructor(platform = process.platform, userHome = homedir) {
        this.platform = platform;
        this.userHome = userHome;
    }
    async move(source, identity, recheck) {
        if (this.platform !== 'darwin' && this.platform !== 'win32')
            throw new Error(`System trash is unsupported on ${this.platform}`);
        const koffi = (await import('koffi')).default;
        if (this.platform === 'darwin') {
            const home = this.userHome();
            if (!await isCanonicalPath(home))
                throw new Error('Unsafe user home');
            const trash = join(home, '.Trash');
            await mkdir(trash, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST')
                throw error; });
            if (!await isCanonicalPath(trash) || !(await lstat(trash)).isDirectory())
                throw new Error('Unsafe system trash directory');
            const destination = await lstat(trash, { bigint: true });
            requireSameDevice(identity, destination);
            const target = join(trash, `d-trash-${randomUUID()}`);
            // RENAME_EXCL is atomic no-replace, including an empty directory collision.
            // No Finder, Apple Events, osascript, or permission-request API is called.
            const lib = koffi.load('/usr/lib/libSystem.B.dylib');
            const rename = lib.func('int renamex_np(const char *oldpath, const char *newpath, unsigned int flags)');
            if (!await isCanonicalPath(trash))
                throw new Error('System trash directory changed');
            const current = await lstat(trash, { bigint: true });
            if (current.dev !== destination.dev || current.ino !== destination.ino)
                throw new Error('System trash identity changed');
            await recheck();
            if (rename(source, target, 0x4) !== 0) {
                const errno = koffi.errno();
                throw Object.assign(new Error(`Move to system trash failed (renamex_np errno ${errno})`), { code: errno === 18 ? 'EXDEV' : 'ETRASH' });
            }
            return;
        }
        // SHFileOperation has MAX_PATH / wildcard semantics. Never pass an alias,
        // wildcard, MULTI_SZ injection or UNC path that can bypass the local bin.
        if (!/^[A-Za-z]:\\/.test(source) || /[\0*?]/.test(source) || source.length >= 260)
            throw new Error('System trash requires a local absolute Windows path below MAX_PATH');
        const kernel = koffi.load('kernel32.dll'), shell = koffi.load('shell32.dll');
        const volumePath = kernel.func('__stdcall', 'GetVolumePathNameW', 'int', ['str16', 'void*', 'uint']);
        const driveType = kernel.func('__stdcall', 'GetDriveTypeW', 'uint', ['str16']);
        const rootBuffer = Buffer.alloc(520);
        if (!volumePath(source, rootBuffer, 260))
            throw new Error('Cannot determine source volume');
        const volume = rootBuffer.toString('utf16le').split('\0')[0];
        if (driveType(volume) !== 3)
            throw new Error('System trash requires a fixed local volume');
        const bin = join(volume, '$Recycle.Bin');
        if (!await isCanonicalPath(bin) || !(await lstat(bin)).isDirectory())
            throw new Error('System recycle bin is unavailable');
        requireSameDevice(identity, await lstat(bin, { bigint: true }));
        if (win32.parse(source).root.toLowerCase() !== volume.toLowerCase())
            throw new Error('Mounted-volume aliases are not supported');
        // shellapi.h uses pack(1) on Win32, natural alignment on Win64.
        const struct = koffi.sizeof('void*') === 4 ? koffi.pack : koffi.struct;
        const infoType = struct({ cbSize: 'uint', i64Size: 'int64', i64NumItems: 'int64' });
        const query = shell.func('__stdcall', 'SHQueryRecycleBinW', 'long', ['str16', koffi.inout(koffi.pointer(infoType))]);
        const info = { cbSize: koffi.sizeof(infoType), i64Size: 0, i64NumItems: 0 };
        if (query(volume, info) !== 0)
            throw new Error('System recycle bin is unavailable on the source volume');
        const operationType = struct({ hwnd: 'void*', wFunc: 'uint', pFrom: 'void*', pTo: 'void*',
            fFlags: 'uint16', fAnyOperationsAborted: 'int', hNameMappings: 'void*', lpszProgressTitle: 'void*' });
        const perform = shell.func('__stdcall', 'SHFileOperationW', 'int', [koffi.inout(koffi.pointer(operationType))]);
        const operation = { hwnd: null, wFunc: 3, pFrom: Buffer.from(`${source}\0\0`, 'utf16le'), pTo: null,
            fFlags: 0x40 | 0x10 | 0x400 | 0x4, fAnyOperationsAborted: 0, hNameMappings: null, lpszProgressTitle: null };
        requireSameDevice(identity, await lstat(bin, { bigint: true }));
        if (!await isCanonicalPath(bin))
            throw new Error('System recycle bin path changed');
        await recheck();
        const result = perform(operation);
        if (result !== 0 || operation.fAnyOperationsAborted) {
            const reason = { 5: 'Access denied', 32: 'Sharing violation', 0x75: 'Operation cancelled',
                0x78: 'Source access denied', 0x79: 'Path too long', 0x85: 'File too large' };
            throw Object.assign(new Error(`SHFileOperationW failed (${result}: ${reason[result] ?? 'Shell operation failed'}; aborted=${operation.fAnyOperationsAborted})`), { code: result === 32 ? 'EBUSY' : [5, 0x78].includes(result) ? 'EACCES' : result === 145 ? 'ENOTEMPTY' : 'ETRASH' });
        }
    }
}
