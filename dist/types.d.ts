/** Stable wire marker: Typert preserves error messages, not custom properties. */
export declare enum TrashErrorCode {
    SessionLockBusy = "D_TRASH_SESSION_LOCK_BUSY",
    Deferred = "D_TRASH_DEFERRED"
}
export declare const SESSION_LOCK_BUSY_PREFIX = "[D_TRASH_SESSION_LOCK_BUSY] ";
export declare const DEFERRED_PREFIX = "[D_TRASH_DEFERRED] ";
/** Queue acknowledgement travels through the existing Remote error channel. */
export declare class DeferredError extends Error {
    readonly code = TrashErrorCode.Deferred;
    constructor(reason: string, cause: unknown);
}
/** Plugin-owned marker; session logs remain owned by DSH. */
export interface TrashRecord {
    /** Host retains a private purge receipt; show diagnosis and allow deletion retry. */
    purgePending?: boolean;
    /** Queued before deletion starts; Restore cancels the queue. */
    deferred?: boolean;
    trashedAt: number;
    workspaceId?: string;
    titleSnapshot?: string;
}
