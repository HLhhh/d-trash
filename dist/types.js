/** Stable wire marker: Typert preserves error messages, not custom properties. */
export var TrashErrorCode;
(function (TrashErrorCode) {
    TrashErrorCode["SessionLockBusy"] = "D_TRASH_SESSION_LOCK_BUSY";
})(TrashErrorCode || (TrashErrorCode = {}));
export const SESSION_LOCK_BUSY_PREFIX = `[${TrashErrorCode.SessionLockBusy}] `;
