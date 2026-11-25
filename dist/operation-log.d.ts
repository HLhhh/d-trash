import type { SessionId } from '@deepseek-ai/dsh-session/types';
export type TrashAction = 'trashSession' | 'restoreSession' | 'removeFromTrash' | 'emptyTrash' | 'startup' | 'recovery' | 'log-rotate' | 'distill';
export interface OperationRecord {
    ts: string;
    action: TrashAction;
    sessionId: SessionId | null;
    stage: string;
    result: string;
    reason: string | null;
}
export declare const MAX_BYTES: number;
export declare const KEEP = 3;
/** Best effort only: neither discovery, I/O, nor the fallback logger may throw. */
export declare class OperationLog {
    private readonly locateHome;
    private readonly fallback;
    private home?;
    constructor(locateHome: (id?: SessionId) => Promise<string>, fallback: (line: string) => void);
    /** Capture stat's home before a purge can rename/remove its source. */
    prepare(id?: SessionId): Promise<void>;
    private degrade;
    private append;
    private rotate;
    write(action: TrashAction, sessionId: SessionId | null, stage: string, result: string, reason?: unknown): Promise<void>;
}
