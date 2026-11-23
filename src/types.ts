/** Stable wire marker: Typert preserves error messages, not custom properties. */
export enum TrashErrorCode {
  SessionLockBusy = 'D_TRASH_SESSION_LOCK_BUSY',
  Deferred = 'D_TRASH_DEFERRED',
}
export const SESSION_LOCK_BUSY_PREFIX = `[${TrashErrorCode.SessionLockBusy}] `
export const DEFERRED_PREFIX = `[${TrashErrorCode.Deferred}] `

/** Queue acknowledgement travels through the existing Remote error channel. */
export class DeferredError extends Error {
  readonly code = TrashErrorCode.Deferred
  constructor(reason: string, cause: unknown) {
    super(`${DEFERRED_PREFIX}${reason}`, { cause })
  }
}

/** Plugin-owned marker; session logs remain owned by DSH. */
export interface TrashRecord {
  /** Host retains a private purge receipt; show diagnosis and allow deletion retry. */
  purgePending?: boolean
  /** Queued before deletion starts; Restore cancels the queue. */
  deferred?: boolean
  trashedAt: number
  workspaceId?: string
  titleSnapshot?: string
}
