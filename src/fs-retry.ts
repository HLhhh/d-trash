import { setTimeout } from 'node:timers/promises'
import { lstat, realpath } from 'node:fs/promises'

/** Accept drive/path spelling case on Windows, but never a junction, symlink,
 * short-name or namespace alias. This also matches the backend's lock folding.
 */
export async function isCanonicalPath(path: string): Promise<boolean> {
  if ((await lstat(path)).isSymbolicLink()) return false
  const actual = await realpath(path)
  return process.platform === 'win32' ? actual.toLowerCase() === path.toLowerCase() : actual === path
}

/** Retry transient sharing/AV failures only. The caller revalidates before
 * every rename attempt; never copy across volumes or delete a conflict target.
 */
export async function retrySharing<T>(operation: () => Promise<T>, platform = process.platform): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (error) {
      if (platform !== 'win32' || attempt >= 4
        || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await setTimeout(50 * (attempt + 1))
    }
  }
}
