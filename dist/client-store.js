/** Client projection only, from Host reads and accepted successful mutations. */
class TrashStore {
    entries = null;
    listeners = new Set();
    revision = 0;
    request = 0;
    baselines = new Map();
    changes = [];
    sequence = 0;
    emptySequence = 0;
    sessionSequences = new Map();
    /** Capture at invocation, shared across menu, hover and every panel. */
    begin(sessionId) {
        const sequence = ++this.sequence;
        if (sessionId === undefined)
            this.emptySequence = sequence;
        else
            this.sessionSequences.set(sessionId, sequence);
        return { sequence, sessionId };
    }
    isCurrent(ticket) {
        return ticket.sessionId === undefined
            ? ticket.sequence === this.sequence
            : ticket.sequence === this.sessionSequences.get(ticket.sessionId)
                && ticket.sequence > this.emptySequence;
    }
    /** Responses carry their invocation ticket, never their arrival order. */
    async accept(ticket, apply, load) {
        if (this.isCurrent(ticket))
            apply();
        else
            await this.refresh(load, () => true);
    }
    getSnapshot = () => this.entries;
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    upsert(sessionId, record) {
        this.change(rows => { rows.set(sessionId, record); });
    }
    remove(sessionId) {
        this.change(rows => { rows.delete(sessionId); });
    }
    clear() {
        this.change(rows => { rows.clear(); });
    }
    /** A late list response must not undo mutations committed while it loaded. */
    async refresh(load, current) {
        const token = ++this.request;
        const revision = this.revision;
        this.baselines.set(token, revision);
        try {
            const rows = new Map(await load());
            if (token !== this.request || !current())
                return;
            for (const change of this.changes) {
                if (change.revision > revision)
                    change.apply(rows);
            }
            this.publish(rows);
        }
        finally {
            this.baselines.delete(token);
            const earliest = Math.min(...this.baselines.values());
            this.changes = this.changes.filter(change => change.revision > earliest);
        }
    }
    change(apply) {
        const revision = ++this.revision;
        if (this.baselines.size)
            this.changes.push({ revision, apply });
        const rows = new Map(this.entries ?? []);
        apply(rows);
        this.publish(rows);
    }
    publish(rows) {
        this.entries = [...rows].sort((a, b) => b[1].trashedAt - a[1].trashedAt);
        for (const listener of this.listeners)
            listener();
    }
}
// One browser bundle/module instance, shared by menu, hover action and panels.
export const trashStore = new TrashStore();
