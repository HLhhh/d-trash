import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { DistillResult } from './types.js';
export interface DistillSource {
    id: SessionId;
    title: string;
    createdAt: number;
    cwd?: string;
    transcript: string;
    /** Validated persistence home; artifacts must stay outside it. */
    protectedHome?: string;
}
export interface DistillOutput {
    type: 'experience' | 'operations' | 'skill-draft' | 'requirements';
    body: string;
}
export interface DistillExecutor {
    run(presetId: string, prompt: string, cwd: string, signal: AbortSignal): Promise<DistillOutput>;
}
export type DistillReader = (id: SessionId, signal: AbortSignal) => Promise<DistillSource>;
export declare class DistillError extends Error {
    readonly stage: string;
    constructor(stage: string, id: SessionId, reason: unknown);
}
/** Abort waiting even for a defective injected executor; consume late rejection. */
export declare function abortable<T>(job: Promise<T>, signal: AbortSignal): Promise<T>;
export declare function distillPrompt(source: DistillSource): string;
export declare function parseDistillOutput(text: string): DistillOutput;
/** Isolated task lifecycle. This class never sees marker/Workspace/write APIs. */
export declare class SessionDistiller {
    private readonly read;
    private readonly executor;
    private readonly directory;
    private readonly stop;
    constructor(read: DistillReader, executor: DistillExecutor | undefined, directory?: string);
    dispose(): void;
    run(id: SessionId, presetId: string): Promise<DistillResult>;
}
