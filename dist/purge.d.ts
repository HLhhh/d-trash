import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
/** Durable intent stays with the marker until all required record cleanup commits. */
export interface PurgeIntent {
    source: string;
    target: string;
    dev: string;
    ino: string;
    logsDeleted: boolean;
    deleting: boolean;
}
interface StagedDeletion {
    status: 'deleted' | 'unmoved';
    home: string;
}
export declare class PurgeError extends Error {
    readonly sessionId: SessionId;
    readonly stage: string;
    constructor(sessionId: SessionId, stage: string, cause: unknown);
}
/** POSIX maintenance only. Never creates/truncates/unlinks a live lock file. */
export declare class SessionPurger {
    private readonly observe;
    private readonly report;
    constructor(observe: (id: SessionId) => Promise<SessionPersistenceSnapshot | undefined>, report?: (id: SessionId, stage: string) => Promise<void>);
    /** Shared authority for operation logs; no environment-variable fallback. */
    home(id: SessionId): Promise<string>;
    homeFromSource(source: string): Promise<string>;
    /** Derive from stat's source, or its durable receipt after the source is gone.
     * DSH_HOME is a shell hint, not the Host's persistence location authority.
     */
    private roots;
    private locate;
    /** flock → recheck → durable intent → final gate → whole-directory rename → close. */
    move(id: SessionId, gate: () => void, save: (intent: PurgeIntent) => Promise<void>): Promise<PurgeIntent>;
    /** Resume only marker intents targeting the sibling staging; never sweep unknown directories. */
    deleteStaged(id: SessionId, intent: PurgeIntent, save: (intent: PurgeIntent) => Promise<void>): Promise<StagedDeletion>;
    /** Separate method permits failure/crash injection in isolated fixtures. */
    removeDirectory(target: string): Promise<void>;
    clearProjection(id: SessionId, home: string): Promise<void>;
}
export {};
