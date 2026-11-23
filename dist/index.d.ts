import { Service, type Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type TrashRecord } from './types.js';
export type { TrashRecord } from './types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        trash: TrashService;
    }
}
/** Host-only owner of trash markers and their archive/restore operations. */
export default class TrashService extends TypertRemoteService {
    static inject: string[];
    private readonly purger;
    private readonly operationLog;
    private readonly action;
    private domainPromise?;
    private persistenceHome?;
    private readonly sessions;
    private boundary;
    private stopped;
    private startupTimer?;
    private startupStarted;
    private readonly startupSettled;
    constructor(ctx: Context);
    /** Cordis class-plugin apply hook. Return immediately; never await maintenance. */
    [Service.init](): void;
    private scheduleStartup;
    private retryDeferred;
    /**
     * Observable trash = marker ∩ archived. Native unarchive bypasses our lock;
     * listTrash reconciles markers left by later native writes. Check both sides
     * of put so a native unarchive during this operation is compensated now.
     */
    trashSession(sessionId: SessionId): Promise<void>;
    /** Remove the marker before unarchiving; restore it only if still archived. */
    restoreSession(sessionId: SessionId): Promise<void>;
    /** Physical deletion, fenced against all other plugin operations and recovery. */
    removeFromTrash(sessionId: SessionId): Promise<boolean>;
    /** Each item commits independently; failures retain markers and name their stages. */
    emptyTrash(): Promise<number>;
    private report;
    private operation;
    /** Use already-open receipts after rename, otherwise obtain an actual stat.
     * list supplies candidate ids only; it never authorizes a guessed log path.
     */
    private logHome;
    /** Any purge/empty first resumes durable intents, including rename-before-crash.
     * deleteStaged validates the sibling staging path for every receipt; invalid
     * (including legacy in-root) targets keep their marker for diagnosis.
     */
    private recoverStaging;
    private purgeSession;
    /** Reconcile normal markers; retain purge receipts as retryable diagnostics. */
    listTrash(): Promise<Array<[SessionId, TrashRecord]>>;
    private domain;
    /** Register synchronously so later calls cannot overtake an awaiting job. */
    private forSession;
    /** Fence earlier sessions and force every later session to wait for us. */
    private exclusive;
    private compensate;
    private workspaceRegistry;
}
