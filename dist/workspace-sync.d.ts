import type { SessionId } from '@deepseek-ai/dsh-session/types';
interface ArchiveSnapshot {
    readonly archivedSessionIds: readonly SessionId[];
    readonly pinnedSessionIds: readonly SessionId[];
}
/** Installed 0.2.2-rc.5 exposes the model itself as workspaces.list. */
export interface WorkspaceProjection {
    getSnapshot(): ArchiveSnapshot;
    subscribe(listener: () => void): () => void;
    replaceArchived(ids: readonly SessionId[]): void;
    replacePinned(ids: readonly SessionId[]): void;
}
export interface WorkspaceReader {
    follow(signal: AbortSignal): AsyncIterable<{
        type: string;
        value?: ArchiveSnapshot;
    }>;
}
/**
 * Read a fresh follow opening baseline, then install only archive/pin sets.
 * Never issue a Workspace business write to echo a Trash operation. The
 * native stream can deliver older frames after our read; changes to these
 * sets trigger another authoritative read, rather than replaying an intent.
 */
export declare class WorkspaceSync {
    private readonly projection;
    private readonly remote;
    private generation;
    private running?;
    private active?;
    private disposed;
    private observed;
    private readonly unsubscribe;
    constructor(projection: WorkspaceProjection, remote: WorkspaceReader);
    /** A newly invoked mutation supersedes any baseline already in flight. */
    invalidate(): void;
    refresh(): Promise<void>;
    dispose(): void;
    private readUntilCurrent;
}
export {};
