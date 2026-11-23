/** Stable wire marker: Typert preserves error messages, not custom properties. */
export enum TrashErrorCode {
  SessionLockBusy = 'D_TRASH_SESSION_LOCK_BUSY',
}
export const SESSION_LOCK_BUSY_PREFIX = `[${TrashErrorCode.SessionLockBusy}] `

/** Plugin-owned marker; session logs remain owned by DSH. */
export interface TrashRecord {
  /** Host retains a private purge receipt; show diagnosis and allow deletion retry. */
  purgePending?: boolean
  trashedAt: number
  workspaceId?: string
  titleSnapshot?: string
}
