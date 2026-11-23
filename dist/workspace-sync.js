const signature = (snapshot) => JSON.stringify([snapshot.archivedSessionIds, snapshot.pinnedSessionIds]);
/**
 * Read a fresh follow opening baseline, then install only archive/pin sets.
 * Never issue a Workspace business write to echo a Trash operation. The
 * native stream can deliver older frames after our read; changes to these
 * sets trigger another authoritative read, rather than replaying an intent.
 */
export class WorkspaceSync {
    projection;
    remote;
    generation = 0;
    running;
    active;
    disposed = false;
    observed;
    unsubscribe;
    constructor(projection, remote) {
        this.projection = projection;
        this.remote = remote;
        if (!projection || typeof projection.getSnapshot !== 'function' || typeof projection.subscribe !== 'function'
            || typeof projection.replaceArchived !== 'function' || typeof projection.replacePinned !== 'function'
            || !remote || typeof remote.follow !== 'function') {
            throw new Error('Trash requires Workspace model read/subscribe/replaceArchived/replacePinned and remote.follow capabilities');
        }
        this.observed = signature(projection.getSnapshot());
        this.unsubscribe = projection.subscribe(() => {
            const next = signature(projection.getSnapshot());
            if (next === this.observed)
                return;
            this.observed = next;
            // Background failures retry on the next frame, action or panel refresh.
            // Explicit callers still receive refresh failures in their action UI.
            void this.refresh().catch(() => { });
        });
    }
    /** A newly invoked mutation supersedes any baseline already in flight. */
    invalidate() { this.generation++; }
    refresh() {
        if (this.disposed)
            return Promise.resolve();
        this.invalidate();
        if (!this.running) {
            const running = this.readUntilCurrent().finally(() => {
                if (this.running === running)
                    this.running = undefined;
            });
            this.running = running;
        }
        return this.running;
    }
    dispose() {
        this.disposed = true;
        this.invalidate();
        this.unsubscribe();
        this.active?.abort();
    }
    async readUntilCurrent() {
        while (!this.disposed) {
            const generation = this.generation;
            const controller = new AbortController();
            this.active = controller;
            const iterator = this.remote.follow(controller.signal)[Symbol.asyncIterator]();
            try {
                const frame = await iterator.next();
                if (this.disposed)
                    return;
                if (generation !== this.generation)
                    continue;
                if (frame.done || frame.value.type !== 'baseline' || !frame.value.value) {
                    throw new Error('Workspace refresh ended without an opening baseline');
                }
                const baseline = frame.value.value;
                const current = this.projection.getSnapshot();
                // Record before installation: the model batches its notifications.
                this.observed = signature(baseline);
                if (JSON.stringify(current.archivedSessionIds) !== JSON.stringify(baseline.archivedSessionIds)) {
                    this.projection.replaceArchived(baseline.archivedSessionIds);
                }
                if (JSON.stringify(current.pinnedSessionIds) !== JSON.stringify(baseline.pinnedSessionIds)) {
                    this.projection.replacePinned(baseline.pinnedSessionIds);
                }
            }
            finally {
                controller.abort();
                await iterator.return?.();
                if (this.active === controller)
                    this.active = undefined;
            }
            if (generation === this.generation)
                return;
        }
    }
}
