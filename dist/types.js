/** Stable wire marker: Typert preserves error messages, not custom properties. */
export var TrashErrorCode;
(function (TrashErrorCode) {
    TrashErrorCode["SessionLockBusy"] = "D_TRASH_SESSION_LOCK_BUSY";
    TrashErrorCode["Deferred"] = "D_TRASH_DEFERRED";
})(TrashErrorCode || (TrashErrorCode = {}));
export const SESSION_LOCK_BUSY_PREFIX = `[${TrashErrorCode.SessionLockBusy}] `;
export const DEFERRED_PREFIX = `[${TrashErrorCode.Deferred}] `;
/** Queue acknowledgement travels through the existing Remote error channel. */
export class DeferredError extends Error {
    code = TrashErrorCode.Deferred;
    constructor(reason, cause) {
        super(`${DEFERRED_PREFIX}${reason}`, { cause });
    }
}
