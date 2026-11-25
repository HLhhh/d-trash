import type { BigIntStats } from 'node:fs';
/** Implementations must move on the same volume, never copy or erase the source.
 * recheck runs after preparation, immediately before the native mutation. */
export interface SystemTrash {
    move(source: string, identity: BigIntStats, recheck: () => Promise<void>): Promise<void>;
}
export declare function requireSameDevice(source: Pick<BigIntStats, 'dev'>, destination: Pick<BigIntStats, 'dev'>): void;
/** Native bindings are lazy; unsupported platforms never load an FFI library. */
export declare class NativeSystemTrash implements SystemTrash {
    private readonly platform;
    private readonly userHome;
    constructor(platform?: NodeJS.Platform, userHome?: () => string);
    move(source: string, identity: BigIntStats, recheck: () => Promise<void>): Promise<void>;
}
