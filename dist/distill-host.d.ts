import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { DistillAgentPreset } from './types.js';
import { type DistillExecutor, type DistillReader } from './distill.js';
export declare function listDistillAgents(ctx: Context): Promise<DistillAgentPreset[]>;
/** Only a read handle; the detached Session is never entered into a store. */
export declare function sessionReader(persistence: () => SessionPersistence, home: (id: SessionId) => Promise<string>): DistillReader;
/** New isolated execution identity; never resolveAgent or resume the source. */
export declare function agentExecutor(ctx: Context): DistillExecutor;
