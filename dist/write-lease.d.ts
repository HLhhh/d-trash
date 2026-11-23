export interface WriteLease {
    verify(): Promise<void>;
    release(): Promise<void>;
}
/** Exactly the JSONL backend's Win32 namespace and path normalization. */
export declare const semaphoreName: (path: string) => string;
/** Native backend-compatible exclusion, never a plugin-only directory lock.
 * Official lease.ts cannot be imported by Electron: TS stripping under
 * node_modules is unsupported. POSIX keeps the stricter existing-file open;
 * Windows uses the backend's count-1 semaphore (no filesystem footprint).
 */
export declare function acquireWriteLease(directory: string, allowMissing?: boolean): Promise<WriteLease>;
