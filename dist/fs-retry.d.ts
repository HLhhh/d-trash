/** Accept drive/path spelling case on Windows, but never a junction, symlink,
 * short-name or namespace alias. This also matches the backend's lock folding.
 */
export declare function isCanonicalPath(path: string): Promise<boolean>;
/** Retry transient sharing/AV failures only. The caller revalidates before
 * every rename attempt; never copy across volumes or delete a conflict target.
 */
export declare function retrySharing<T>(operation: () => Promise<T>, platform?: NodeJS.Platform): Promise<T>;
