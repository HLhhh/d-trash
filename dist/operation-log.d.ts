import type { SessionId } from '@deepseek-ai/dsh-session/types';
export type TrashAction = 'trashSession' | 'restoreSession' | 'removeFromTrash' | 'emptyTrash' | 'recovery';
export interface OperationRecord {
    ts: string;
    action: TrashAction;
    sessionId: SessionId | null;
    stage: string;
    result: string;
    reason: string | null;
}
/** Best effort only: neither discovery, I/O, nor the fallback logger may throw. */
export declare class OperationLog {
    private readonly locateHome;
    private readonly fallback;
    private home?;
    constructor(locateHome: (id?: SessionId) => Promise<string>, fallback: (line: string) => void);
    /** Capture stat's home before a purge can rename/remove its source. */
    prepare(id?: SessionId): Promise<void>;
    write(action: TrashAction, sessionId: SessionId | null, stage: string, result: string, reason?: unknown): Promise<void>;
}
