import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TrashRecord } from './types.js';
export type TrashEntries = Array<[SessionId, TrashRecord]>;
export interface WriteTicket {
    readonly sequence: number;
    readonly sessionId?: SessionId;
}
/** Client projection only, from Host reads and accepted successful mutations. */
declare class TrashStore {
    private entries;
    private readonly listeners;
    private revision;
    private request;
    private readonly baselines;
    private changes;
    private sequence;
    private emptySequence;
    private readonly sessionSequences;
    /** Capture at invocation, shared across menu, hover and every panel. */
    begin(sessionId?: SessionId): WriteTicket;
    isCurrent(ticket: WriteTicket): boolean;
    /** Responses carry their invocation ticket, never their arrival order. */
    accept(ticket: WriteTicket, apply: () => void, load: () => Promise<TrashEntries>): Promise<void>;
    getSnapshot: () => TrashEntries | null;
    subscribe: (listener: () => void) => (() => void);
    upsert(sessionId: SessionId, record: TrashRecord): void;
    remove(sessionId: SessionId): void;
    clear(): void;
    /** A late list response must not undo mutations committed while it loaded. */
    refresh(load: () => Promise<TrashEntries>, current: () => boolean): Promise<void>;
    private change;
    private publish;
}
export declare const trashStore: TrashStore;
export {};
