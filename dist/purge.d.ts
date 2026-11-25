import { type SystemTrash } from './system-trash.js';
import { TrashErrorCode } from './types.js';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
/** Durable intent stays with the marker until all required record cleanup commits. */
export interface MoveIntent {
    source: string;
    dev: string;
    ino: string;
    moving: true;
}
/** Compatibility with pre-5.2 staging receipts. Never rm their payload. */
export interface LegacyPurgeIntent {
    source: string;
    target: string;
    dev: string;
    ino: string;
    logsDeleted: boolean;
    deleting: boolean;
    moving?: true;
}
export type PurgeIntent = MoveIntent | LegacyPurgeIntent;
interface StagedDeletion {
    status: 'deleted' | 'unmoved';
    home: string;
}
export declare class PurgeError extends Error {
    readonly sessionId: SessionId;
    readonly stage: string;
    readonly code?: TrashErrorCode | undefined;
    constructor(sessionId: SessionId, stage: string, cause: unknown, code?: TrashErrorCode | undefined);
}
/** JSONL maintenance. Never creates/truncates/unlinks a live POSIX lock file. */
export declare class SessionPurger {
    private readonly observe;
    private readonly report;
    private readonly systemTrash;
    constructor(observe: (id: SessionId) => Promise<SessionPersistenceSnapshot | undefined>, report?: (id: SessionId, stage: string) => Promise<void>, systemTrash?: SystemTrash);
    /** Shared authority for operation logs; no environment-variable fallback. */
    home(id: SessionId): Promise<string>;
    homeFromSource(source: string): Promise<string>;
    /** Derive from stat's source, or its durable receipt after the source is gone.
     * DSH_HOME is a shell hint, not the Host's persistence location authority.
     */
    private roots;
    private locate;
    /** Write lease → recheck → durable intent → final gate → whole-directory system trash move → close. */
    move(id: SessionId, gate: () => void, save: (intent: PurgeIntent) => Promise<void>): Promise<'moved' | 'logs-absent'>;
    private assertAbsent;
    /** New receipts use source presence only; the OS destination is not authority. */
    deleteStaged(id: SessionId, intent: PurgeIntent, save: (intent: PurgeIntent) => Promise<void>): Promise<StagedDeletion>;
    clearProjection(id: SessionId, home: string): Promise<void>;
}
export {};
