var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SessionPurger, PurgeError } from './purge.js';
import { OperationLog } from './operation-log.js';
const trashDomain = defineDomain({
    name: 'trash',
    version: 1,
    tables: {
        trash: domainTable(z.object({
            trashedAt: z.number(),
            workspaceId: z.string().optional(),
            titleSnapshot: z.string().optional(),
            purge: z.object({ source: z.string(), target: z.string(), dev: z.string(), ino: z.string(),
                logsDeleted: z.boolean(), deleting: z.boolean() }).optional(),
        })),
    },
});
let TrashService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _trashSession_decorators;
    let _restoreSession_decorators;
    let _removeFromTrash_decorators;
    let _emptyTrash_decorators;
    let _listTrash_decorators;
    return class TrashService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _trashSession_decorators = [Remote('trashSession')];
            _restoreSession_decorators = [Remote('restoreSession')];
            _removeFromTrash_decorators = [Remote('removeFromTrash')];
            _emptyTrash_decorators = [Remote('emptyTrash')];
            _listTrash_decorators = [Remote('listTrash')];
            __esDecorate(this, null, _trashSession_decorators, { kind: "method", name: "trashSession", static: false, private: false, access: { has: obj => "trashSession" in obj, get: obj => obj.trashSession }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _restoreSession_decorators, { kind: "method", name: "restoreSession", static: false, private: false, access: { has: obj => "restoreSession" in obj, get: obj => obj.restoreSession }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _removeFromTrash_decorators, { kind: "method", name: "removeFromTrash", static: false, private: false, access: { has: obj => "removeFromTrash" in obj, get: obj => obj.removeFromTrash }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _emptyTrash_decorators, { kind: "method", name: "emptyTrash", static: false, private: false, access: { has: obj => "emptyTrash" in obj, get: obj => obj.emptyTrash }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listTrash_decorators, { kind: "method", name: "listTrash", static: false, private: false, access: { has: obj => "listTrash" in obj, get: obj => obj.listTrash }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['typert', 'storageDomain', 'workspaceRegistry', 'sessionPersistence'];
        purger = __runInitializers(this, _instanceExtraInitializers);
        operationLog;
        action = new AsyncLocalStorage();
        domainPromise;
        sessions = new Map();
        boundary = Promise.resolve();
        constructor(ctx) {
            super(ctx, 'trash', { namespace: 'trash' });
            this.purger = new SessionPurger(async (id) => {
                const persistence = this.ctx.get('sessionPersistence');
                if (!persistence)
                    throw new Error('TrashService requires sessionPersistence');
                return persistence.stat(id);
            }, (id, stage) => this.report(id, stage, 'ok'));
            this.operationLog = new OperationLog(id => this.logHome(id), line => this.ctx.logger.info(line));
            ctx.effect(() => async () => {
                await this.exclusive(async () => {
                    // An unsuccessful open owns no handle; close failures still propagate.
                    const domain = await this.domainPromise?.catch(() => undefined);
                    await domain?.close();
                });
            });
        }
        /**
         * Observable trash = marker ∩ archived. Native unarchive bypasses our lock;
         * listTrash reconciles markers left by later native writes. Check both sides
         * of put so a native unarchive during this operation is compensated now.
         */
        async trashSession(sessionId) {
            return this.forSession(sessionId, () => this.operation('trashSession', sessionId, async () => {
                const table = (await this.domain()).table('trash');
                const registry = this.workspaceRegistry();
                if (table.get(sessionId)?.purge)
                    throw new PurgeError(sessionId, 'gate', 'Deletion is pending; retry physical deletion');
                const wasArchived = registry.archivedSessionIds.includes(sessionId);
                // A rejection can follow the archive commit (e.g. stopActivity). Leave
                // that archive intact and propagate the failure without adding a marker.
                await registry.archiveSession(sessionId, { stopActivity: true });
                const unarchived = () => new Error('Session was unarchived while moving to trash');
                if (!registry.archivedSessionIds.includes(sessionId)) {
                    return this.compensate(unarchived(), async () => { await table.delete(sessionId); });
                }
                try {
                    await table.put(sessionId, { trashedAt: Date.now() });
                }
                catch (error) {
                    return this.compensate(error, async () => {
                        // Never unarchive a committed marker, an existing native archive,
                        // or an unreadable/quarantined domain whose commit is uncertain.
                        if (!wasArchived && table.get(sessionId) === undefined) {
                            await registry.unarchiveSession(sessionId);
                        }
                    });
                }
                if (!registry.archivedSessionIds.includes(sessionId)) {
                    return this.compensate(unarchived(), async () => { await table.delete(sessionId); });
                }
            }));
        }
        /** Remove the marker before unarchiving; restore it only if still archived. */
        async restoreSession(sessionId) {
            return this.forSession(sessionId, () => this.operation('restoreSession', sessionId, async () => {
                const table = (await this.domain()).table('trash');
                const registry = this.workspaceRegistry();
                const record = table.get(sessionId);
                if (record?.purge)
                    throw new PurgeError(sessionId, 'gate', 'Deletion is pending; session cannot be restored');
                await table.delete(sessionId);
                try {
                    await registry.unarchiveSession(sessionId);
                }
                catch (error) {
                    return this.compensate(error, async () => {
                        // A post-commit rejection must not reintroduce an active marker.
                        if (record !== undefined && registry.archivedSessionIds.includes(sessionId)) {
                            await table.put(sessionId, record);
                        }
                    });
                }
            }));
        }
        /** Physical deletion, fenced against all other plugin operations and recovery. */
        async removeFromTrash(sessionId) {
            return this.exclusive(() => this.operation('removeFromTrash', sessionId, async () => {
                await this.recoverStaging();
                return this.purgeSession(sessionId);
            }));
        }
        /** Each item commits independently; failures retain markers and name their stages. */
        async emptyTrash() {
            let deleted = 0;
            let failed = 0;
            return this.exclusive(() => this.operation('emptyTrash', null, async () => {
                await this.recoverStaging();
                const ids = [...(await this.domain()).table('trash').keys()];
                const failures = [];
                for (const id of ids) {
                    try {
                        if (await this.operation('emptyTrash', id, () => this.purgeSession(id)))
                            deleted++;
                    }
                    catch (error) {
                        failures.push(error);
                        failed++;
                    }
                }
                if (failures.length)
                    throw new AggregateError(failures, `Physical deletion: ${deleted} deleted, ${failures.length} failed: ${failures.map(String).join('; ')}`);
                return deleted;
            }, 'summary', () => `${deleted} deleted, ${failed} failed`));
        }
        async report(sessionId, stage, result, error) {
            await this.operationLog.write(this.action.getStore() ?? 'removeFromTrash', sessionId, stage, result, error);
        }
        operation(action, id, job, stage = 'complete', reason) {
            return this.action.run(action, async () => {
                await this.operationLog.prepare(id ?? undefined);
                try {
                    const result = await job();
                    await this.report(id, stage, 'ok', reason?.());
                    return result;
                }
                catch (error) {
                    await this.report(id, stage, 'failed', error);
                    throw error;
                }
            });
        }
        /** Use already-open receipts after rename, otherwise obtain an actual stat.
         * list supplies candidate ids only; it never authorizes a guessed log path.
         */
        async logHome(id) {
            const domain = await this.domainPromise?.catch(() => undefined);
            const table = domain?.table('trash');
            const source = id === undefined ? undefined : table?.get(id)?.purge?.source;
            if (source)
                try {
                    return await this.purger.homeFromSource(source);
                }
                catch { /* try stat */ }
            if (id !== undefined)
                try {
                    return await this.purger.home(id);
                }
                catch { /* try other evidence */ }
            for (const [candidate, record] of table?.entries() ?? []) {
                try {
                    return record.purge ? await this.purger.homeFromSource(record.purge.source) : await this.purger.home(candidate);
                }
                catch { /* another receipt/session may still locate this Host's home */ }
            }
            const persistence = this.ctx.get('sessionPersistence');
            if (persistence)
                for (const snapshot of await persistence.list()) {
                    try {
                        return await this.purger.home(snapshot.header.id);
                    }
                    catch { /* skip unreliable locations */ }
                }
            throw new Error('No reliable stat-derived home for operation log');
        }
        /** Any purge/empty first resumes durable intents, including rename-before-crash.
         * deleteStaged validates the sibling staging path for every receipt; invalid
         * (including legacy in-root) targets keep their marker for diagnosis.
         */
        async recoverStaging() {
            const table = (await this.domain()).table('trash');
            for (const [id, record] of [...table.entries()]) {
                if (!record.purge)
                    continue;
                const intent = { ...record.purge };
                await this.action.run('recovery', async () => {
                    await this.operationLog.prepare(id);
                    try {
                        const result = await this.purger.deleteStaged(id, intent, purge => table.put(id, { ...record, purge: { ...purge } }));
                        if (result.status === 'unmoved') {
                            const { purge: _, ...original } = record;
                            await table.put(id, original);
                        }
                        else {
                            await table.put(id, { ...record, purge: { ...intent, logsDeleted: true } });
                        }
                        await this.report(id, 'recovery', result.status);
                    }
                    catch (error) {
                        await this.report(id, 'recovery', 'failed', error);
                    }
                });
            }
        }
        async purgeSession(sessionId) {
            const table = (await this.domain()).table('trash');
            const registry = this.workspaceRegistry();
            let record = table.get(sessionId);
            let stage = 'gate';
            try {
                if (!record)
                    throw new Error('Session is not in trash');
                if (!record.purge) {
                    const original = record;
                    const gate = () => {
                        if (!table.get(sessionId) || !registry.archivedSessionIds.includes(sessionId)) {
                            throw new Error('Session must be in trash and still archived');
                        }
                    };
                    await this.purger.move(sessionId, gate, async (purge) => {
                        await table.put(sessionId, { ...original, purge: { ...purge } });
                    });
                    record = table.get(sessionId);
                }
                stage = 'delete-staged';
                const intent = { ...record.purge };
                const result = await this.purger.deleteStaged(sessionId, intent, purge => table.put(sessionId, { ...record, purge: { ...purge } }));
                if (result.status !== 'deleted')
                    throw new Error('Rename did not commit; retry deletion');
                await this.report(sessionId, stage, 'ok');
                record = { ...record, purge: { ...intent, logsDeleted: true } };
                await table.put(sessionId, record);
                stage = 'detach';
                const failures = [];
                for (const workspace of registry.list()) {
                    try {
                        if (!workspace.sessionIds.includes(sessionId))
                            continue;
                        await workspace.detachSession(sessionId);
                        await this.report(sessionId, 'detach', 'ok');
                    }
                    catch (error) {
                        failures.push(error);
                        await this.report(sessionId, 'detach', 'failed', error);
                    }
                }
                if (failures.length)
                    throw new AggregateError(failures, failures.map(String).join('; '));
                stage = 'unarchive';
                await registry.unarchiveSession(sessionId);
                await this.report(sessionId, stage, 'ok');
                stage = 'marker';
                await table.delete(sessionId);
                await this.report(sessionId, stage, 'ok');
                try {
                    await this.purger.clearProjection(sessionId, result.home);
                    await this.report(sessionId, 'projection', 'ok');
                }
                catch (error) {
                    await this.report(sessionId, 'projection', 'warning', error);
                }
                return true;
            }
            catch (error) {
                const failure = error instanceof PurgeError ? error : new PurgeError(sessionId, stage, error);
                await this.report(sessionId, failure.stage, 'failed', failure);
                throw failure;
            }
        }
        /** Reconcile normal markers; retain purge receipts as retryable diagnostics. */
        async listTrash() {
            // Keep the admitted call's dependency available while disposal waits for it.
            const registry = this.workspaceRegistry();
            // Share concurrent first opens (including failures) before taking the
            // write fence. Cleanup must not delete a later trashSession's new marker.
            const opening = this.domain();
            return this.exclusive(async () => {
                const table = (await opening).table('trash');
                for (;;) {
                    const archived = new Set(registry.archivedSessionIds);
                    const entries = [...table.entries()];
                    const stale = entries.filter(([id, record]) => !record.purge && !archived.has(id)).map(([id]) => id);
                    if (!stale.length)
                        return entries.map(([id, record]) => {
                            const { purge, ...visible } = record;
                            return [id, { ...visible, ...(purge ? { purgePending: true } : {}) }];
                        });
                    await table.deleteMany(stale);
                    // Native unarchive can run during persistence; check again before
                    // returning. Plugin writes remain fenced for the complete cleanup.
                }
            });
        }
        domain() {
            if (this.domainPromise)
                return this.domainPromise;
            const opening = Promise.resolve().then(() => this.ctx.storageDomain.open(trashDomain))
                .catch((error) => {
                if (this.domainPromise === opening)
                    this.domainPromise = undefined;
                throw error;
            });
            this.domainPromise = opening;
            return opening;
        }
        /** Register synchronously so later calls cannot overtake an awaiting job. */
        forSession(sessionId, job) {
            const result = Promise.all([this.boundary, this.sessions.get(sessionId)]).then(job);
            const settled = result.then(() => { }, () => { });
            this.sessions.set(sessionId, settled);
            void settled.then(() => {
                if (this.sessions.get(sessionId) === settled)
                    this.sessions.delete(sessionId);
            });
            return result;
        }
        /** Fence earlier sessions and force every later session to wait for us. */
        exclusive(job) {
            const result = Promise.all([this.boundary, ...this.sessions.values()]).then(job);
            this.boundary = result.then(() => { }, () => { });
            return result;
        }
        async compensate(error, rollback) {
            try {
                await rollback();
            }
            catch (recoveryError) {
                throw new AggregateError([error, recoveryError], 'Trash operation and compensation failed', { cause: error });
            }
            throw error;
        }
        workspaceRegistry() {
            const registry = this.ctx.get('workspaceRegistry');
            if (registry === undefined) {
                throw new Error('TrashService requires workspaceRegistry');
            }
            return registry;
        }
    };
})();
/** Host-only owner of trash markers and their archive/restore operations. */
export default TrashService;
