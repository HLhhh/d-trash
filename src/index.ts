import { Service, type Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { AsyncLocalStorage } from 'node:async_hooks'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionPurger, PurgeError, type PurgeIntent } from './purge.js'
import { TrashErrorCode, DeferredError, type TrashRecord } from './types.js'
import { OperationLog, type TrashAction } from './operation-log.js'

export type { TrashRecord } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    trash: TrashService
  }
}

// Public Session Controller signature verified in installed rc.5. A narrow
// type bridge avoids a runtime controller dependency or claiming event ownership.
interface SessionRemovalEmitter {
  emit(event: 'api-session/removed', sessionId: SessionId): void
}

interface StoredTrashRecord extends TrashRecord { purge?: PurgeIntent; deferredAt?: number }

const trashDomain = defineDomain({
  name: 'trash',
  version: 1,
  tables: {
    trash: domainTable<SessionId, StoredTrashRecord>(z.object({
      trashedAt: z.number(),
      workspaceId: z.string().optional(),
      titleSnapshot: z.string().optional(),
      deferredAt: z.number().optional(),
      purge: z.object({ source: z.string(), target: z.string(), dev: z.string(), ino: z.string(),
        logsDeleted: z.boolean(), deleting: z.boolean() }).optional(),
    })),
  },
})

/** Host-only owner of trash markers and their archive/restore operations. */
export default class TrashService extends TypertRemoteService {
  static inject = ['typert', 'storageDomain', 'workspaceRegistry', 'sessionPersistence']

  private readonly purger: SessionPurger
  private readonly operationLog: OperationLog
  private readonly action = new AsyncLocalStorage<TrashAction>()
  private domainPromise?: Promise<Domain<typeof trashDomain>>
  private persistenceHome?: string
  private readonly sessions = new Map<SessionId, Promise<void>>()
  private boundary: Promise<void> = Promise.resolve()
  private stopped = false
  private startupTimer?: ReturnType<typeof setTimeout>
  private startupStarted = false
  private readonly startupSettled = new Set<SessionId>()

  constructor(ctx: Context) {
    super(ctx, 'trash', { namespace: 'trash' })
    this.purger = new SessionPurger(async id => {
      const persistence = this.ctx.get('sessionPersistence')
      if (!persistence) throw new Error('TrashService requires sessionPersistence')
      return persistence.stat(id)
    }, (id, stage) => this.report(id, stage, 'ok'))
    this.operationLog = new OperationLog(id => this.logHome(id), line => this.ctx.logger.info(line))
    ctx.effect(() => async () => {
      this.stopped = true
      clearTimeout(this.startupTimer)
      await this.exclusive(async () => {
        // An unsuccessful open owns no handle; close failures still propagate.
        const domain = await this.domainPromise?.catch(() => undefined)
        await domain?.close()
      })
    })
  }

  /** Cordis class-plugin apply hook. Return immediately; never await maintenance. */
  [Service.init](): void {
    if (this.startupStarted || this.stopped) return
    this.startupStarted = true
    this.scheduleStartup(0)
  }

  private scheduleStartup(delay: number): void {
    if (this.stopped) return
    this.startupTimer = setTimeout(() => {
      if (this.stopped) return
      void this.retryDeferred().then(retry => {
        if (retry) this.scheduleStartup(Math.min(30_000, Math.max(1000, delay * 2)))
      }).catch(async error => {
        await this.action.run('startup', () => this.report(null, 'scan', 'failed', error))
        this.scheduleStartup(Math.min(30_000, Math.max(1000, delay * 2)))
      }).catch(() => { /* maintenance must never reject into Host startup */ })
    }, delay)
    this.startupTimer.unref()
  }

  private async retryDeferred(): Promise<boolean> {
    // Dependency/domain readiness may lag apply. Retry safely with backoff.
    this.workspaceRegistry()
    if (!this.ctx.get('sessionPersistence')) throw new Error('TrashService requires sessionPersistence')
    const ids = await this.exclusive(async () => [...(await this.domain()).table('trash').entries()]
      .filter(([id, record]) => record.deferredAt !== undefined && !record.purge && !this.startupSettled.has(id))
      .map(([id]) => id))
    let retry = false
    for (const id of ids) {
      if (this.stopped) break
      await this.exclusive(async () => {
        if (this.stopped) return
        const record = (await this.domain()).table('trash').get(id)
        // Restore/list/re-trash can cancel between items. Receipts use recovery only.
        if (!record || record.deferredAt === undefined || record.purge) return
        try {
          await this.operation('startup', id, () => this.purgeSession(id))
          this.startupSettled.add(id)
        } catch (error) {
          if (error instanceof DeferredError) this.startupSettled.add(id)
          else retry = true // includes a persistence service that is not ready yet
        }
      })
    }
    return retry
  }

  /**
   * Observable trash = marker ∩ archived. Native unarchive bypasses our lock;
   * listTrash reconciles markers left by later native writes. Check both sides
   * of put so a native unarchive during this operation is compensated now.
   */
  @Remote('trashSession')
  async trashSession(sessionId: SessionId): Promise<void> {
    return this.forSession(sessionId, () => this.operation('trashSession', sessionId, async () => {
      const table = (await this.domain()).table('trash')
      const registry = this.workspaceRegistry()
      if (table.get(sessionId)?.purge) throw new PurgeError(sessionId, 'gate', 'Deletion is pending; retry physical deletion')
      const wasArchived = registry.archivedSessionIds.includes(sessionId)
      // A rejection can follow the archive commit (e.g. stopActivity). Leave
      // that archive intact and propagate the failure without adding a marker.
      await registry.archiveSession(sessionId, { stopActivity: true })
      const unarchived = (): Error => new Error('Session was unarchived while moving to trash')
      if (!registry.archivedSessionIds.includes(sessionId)) {
        return this.compensate(unarchived(), async () => { await table.delete(sessionId) })
      }
      try {
        await table.put(sessionId, { trashedAt: Date.now() })
      } catch (error) {
        return this.compensate(error, async () => {
          // Never unarchive a committed marker, an existing native archive,
          // or an unreadable/quarantined domain whose commit is uncertain.
          if (!wasArchived && table.get(sessionId) === undefined) {
            await registry.unarchiveSession(sessionId)
          }
        })
      }
      if (!registry.archivedSessionIds.includes(sessionId)) {
        return this.compensate(unarchived(), async () => { await table.delete(sessionId) })
      }
    }))
  }

  /** Remove the marker before unarchiving; restore it only if still archived. */
  @Remote('restoreSession')
  async restoreSession(sessionId: SessionId): Promise<void> {
    return this.forSession(sessionId, () => this.operation('restoreSession', sessionId, async () => {
      const table = (await this.domain()).table('trash')
      const registry = this.workspaceRegistry()
      const record = table.get(sessionId)
      if (record?.purge) throw new PurgeError(sessionId, 'gate', 'Deletion is pending; session cannot be restored')
      if (record?.deferredAt !== undefined) {
        const { deferredAt: _, ...original } = record
        await table.put(sessionId, original)
        return // Cancel queued deletion; keep the session in ordinary trash.
      }
      await table.delete(sessionId)
      try {
        await registry.unarchiveSession(sessionId)
      } catch (error) {
        return this.compensate(error, async () => {
          // A post-commit rejection must not reintroduce an active marker.
          if (record !== undefined && registry.archivedSessionIds.includes(sessionId)) {
            await table.put(sessionId, record)
          }
        })
      }
    }))
  }

  /** Physical deletion, fenced against all other plugin operations and recovery. */
  @Remote('removeFromTrash')
  async removeFromTrash(sessionId: SessionId): Promise<boolean> {
    return this.exclusive(() => this.operation('removeFromTrash', sessionId, async () => {
      await this.recoverStaging()
      return this.purgeSession(sessionId)
    }))
  }

  /** Each item commits independently; failures retain markers and name their stages. */
  @Remote('emptyTrash')
  async emptyTrash(): Promise<number> {
    let deleted = 0
    let failed = 0
    let deferred = 0
    return this.exclusive(() => this.operation('emptyTrash', null, async () => {
      await this.recoverStaging()
      const ids = [...(await this.domain()).table('trash').keys()]
      const failures: unknown[] = []
      for (const id of ids) {
        try { if (await this.operation('emptyTrash', id, () => this.purgeSession(id))) deleted++ }
        catch (error) {
          if (error instanceof DeferredError) deferred++
          else { failures.push(error); failed++ }
        }
      }
      if (failures.length) {
        throw new AggregateError(failures,
          `Physical deletion: ${deleted} deleted, ${failed} failed, ${deferred} queued: ${failures.map(String).join('; ')}`)
      }
      if (deferred) throw new DeferredError(`Physical deletion: ${deleted} deleted, 0 failed, ${deferred} queued`, undefined)
      return deleted
    }, 'summary', () => `${deleted} deleted, ${failed} failed, ${deferred} queued`))
  }

  private async report(sessionId: SessionId | null, stage: string, result: string, error?: unknown): Promise<void> {
    await this.operationLog.write(this.action.getStore() ?? 'removeFromTrash', sessionId, stage, result, error)
  }

  private operation<T>(action: TrashAction, id: SessionId | null, job: () => Promise<T>,
    stage = 'complete', reason?: () => string): Promise<T> {
    return this.action.run(action, async () => {
      await this.operationLog.prepare(id ?? undefined)
      try {
        const result = await job()
        await this.report(id, stage, 'ok', reason?.())
        return result
      } catch (error) {
        await this.report(id, stage, error instanceof DeferredError ? 'deferred' : 'failed', error)
        throw error
      }
    })
  }

  /** Use already-open receipts after rename, otherwise obtain an actual stat.
   * list supplies candidate ids only; it never authorizes a guessed log path.
   */
  private async logHome(id?: SessionId): Promise<string> {
    // Reuse only a home previously validated from stat/source, including when
    // a stale Client re-trashes a session whose logs have already been deleted.
    if (this.persistenceHome) return this.persistenceHome
    const domain = await this.domainPromise?.catch(() => undefined)
    const table = domain?.table('trash')
    const source = id === undefined ? undefined : table?.get(id)?.purge?.source
    if (source) try { return this.persistenceHome = await this.purger.homeFromSource(source) } catch { /* try stat */ }
    if (id !== undefined) try { return this.persistenceHome = await this.purger.home(id) } catch { /* try other evidence */ }
    for (const [candidate, record] of table?.entries() ?? []) {
      try {
        return this.persistenceHome = record.purge ? await this.purger.homeFromSource(record.purge.source) : await this.purger.home(candidate)
      } catch { /* another receipt/session may still locate this Host's home */ }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence) for (const snapshot of await persistence.list()) {
      try { return this.persistenceHome = await this.purger.home(snapshot.header.id) } catch { /* skip unreliable locations */ }
    }
    throw new Error('No reliable stat-derived home for operation log')
  }

  /** Any purge/empty first resumes durable intents, including rename-before-crash.
   * deleteStaged validates the sibling staging path for every receipt; invalid
   * (including legacy in-root) targets keep their marker for diagnosis.
   */
  private async recoverStaging(): Promise<void> {
    const table = (await this.domain()).table('trash')
    for (const [id, record] of [...table.entries()]) {
      if (!record.purge) continue
      const intent = { ...record.purge }
      await this.action.run('recovery', async () => {
        await this.operationLog.prepare(id)
        try {
          const result = await this.purger.deleteStaged(id, intent,
            purge => table.put(id, { ...record, purge: { ...purge } }))
          if (result.status === 'unmoved') {
            const { purge: _, ...original } = record
            await table.put(id, original)
          } else {
            await table.put(id, { ...record, purge: { ...intent, logsDeleted: true } })
          }
          await this.report(id, 'recovery', result.status)
        } catch (error) { await this.report(id, 'recovery', 'failed', error) }
      })
    }
  }

  private async purgeSession(sessionId: SessionId): Promise<boolean> {
    const table = (await this.domain()).table('trash')
    const registry = this.workspaceRegistry()
    let record = table.get(sessionId)
    let home: string | undefined
    let stage = 'gate'
    try {
      if (!record) throw new Error('Session is not in trash')
      if (!record.purge) {
        const original = record
        const gate = (): void => {
          if (!table.get(sessionId) || !registry.archivedSessionIds.includes(sessionId)) {
            throw new Error('Session must be in trash and still archived')
          }
        }
        const moved = await this.purger.move(sessionId, gate, async purge => {
          const { deferredAt: _, ...started } = original
          await table.put(sessionId, { ...started, purge: { ...purge } })
        })
        if (moved === 'logs-absent') {
          await this.report(sessionId, 'logs-absent', 'ok', 'stat returned undefined; local logs already absent; cleaning records only')
        }
        record = table.get(sessionId)!
      }
      if (record.purge) {
        stage = 'delete-staged'
        const intent = { ...record.purge }
        const result = await this.purger.deleteStaged(sessionId, intent,
          purge => table.put(sessionId, { ...record!, purge: { ...purge } }))
        if (result.status !== 'deleted') throw new Error('Rename did not commit; retry deletion')
        home = result.home
        await this.report(sessionId, stage, 'ok')
        record = { ...record, purge: { ...intent, logsDeleted: true } }
        await table.put(sessionId, record)
      }
      stage = 'detach'
      const failures: unknown[] = []
      for (const workspace of registry.list()) {
        try {
          if (!workspace.sessionIds.includes(sessionId)) continue
          await workspace.detachSession(sessionId)
          await this.report(sessionId, 'detach', 'ok')
        }
        catch (error) { failures.push(error); await this.report(sessionId, 'detach', 'failed', error) }
      }
      if (failures.length) throw new AggregateError(failures, failures.map(String).join('; '))
      stage = 'unarchive'
      await registry.unarchiveSession(sessionId)
      await this.report(sessionId, stage, 'ok')
      stage = 'marker'
      await table.delete(sessionId)
      await this.report(sessionId, stage, 'ok')
      await this.notifyRemoved(sessionId)
      try { await this.purger.clearProjection(sessionId, home ?? await this.logHome(sessionId)); await this.report(sessionId, 'projection', 'ok') }
      catch (error) { await this.report(sessionId, 'projection', 'warning', error) }
      return true
    } catch (error) {
      const failure = error instanceof PurgeError ? error : new PurgeError(sessionId, stage, error)
      await this.report(sessionId, failure.stage, 'failed', failure)
      const current = table.get(sessionId)
      if (failure.stage === 'lock' && failure.code === TrashErrorCode.SessionLockBusy
        && current && !current.purge && registry.archivedSessionIds.includes(sessionId)) {
        try { await table.put(sessionId, { ...current, deferredAt: current.deferredAt ?? Date.now() }) }
        catch (saveError) {
          const rejected = new PurgeError(sessionId, 'deferred', saveError)
          await this.report(sessionId, 'deferred', 'failed', rejected)
          throw rejected
        }
        await this.report(sessionId, 'deferred', 'ok', failure)
        throw new DeferredError(`Queued for deletion after DSH restart: ${failure.message}`, failure)
      }
      throw failure
    }
  }

  /** Both physical and absent-log cleanup reach here only after marker commit.
   * This is a notification, not a registry mutation or a deletion receipt.
   */
  private async notifyRemoved(sessionId: SessionId): Promise<void> {
    try {
      (this.ctx as unknown as SessionRemovalEmitter).emit('api-session/removed', sessionId)
    } catch (error) {
      await this.report(sessionId, 'removed', 'warning', error)
      return
    }
    await this.report(sessionId, 'removed', 'ok')
  }

  /** Reconcile normal markers; retain purge receipts as retryable diagnostics. */
  @Remote('listTrash')
  async listTrash(): Promise<Array<[SessionId, TrashRecord]>> {
    // Keep the admitted call's dependency available while disposal waits for it.
    const registry = this.workspaceRegistry()
    // Share concurrent first opens (including failures) before taking the
    // write fence. Cleanup must not delete a later trashSession's new marker.
    const opening = this.domain()
    return this.exclusive(async () => {
      const table = (await opening).table('trash')
      for (;;) {
        const archived = new Set(registry.archivedSessionIds)
        const entries = [...table.entries()]
        const stale = entries.filter(([id, record]) => !record.purge && !archived.has(id)).map(([id]) => id)
        if (!stale.length) return entries.map(([id, record]) => {
          const { purge, deferredAt, ...visible } = record
          return [id, { ...visible, ...(purge ? { purgePending: true } : {}),
            ...(deferredAt !== undefined && !purge ? { deferred: true } : {}) }]
        })
        await table.deleteMany(stale)
        // Native unarchive can run during persistence; check again before
        // returning. Plugin writes remain fenced for the complete cleanup.
      }
    })
  }

  private domain(): Promise<Domain<typeof trashDomain>> {
    if (this.domainPromise) return this.domainPromise
    const opening = Promise.resolve().then(() => this.ctx.storageDomain.open(trashDomain))
      .catch((error: unknown) => {
        if (this.domainPromise === opening) this.domainPromise = undefined
        throw error
      })
    this.domainPromise = opening
    return opening
  }

  /** Register synchronously so later calls cannot overtake an awaiting job. */
  private forSession<T>(sessionId: SessionId, job: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.boundary, this.sessions.get(sessionId)]).then(job)
    const settled = result.then(() => {}, () => {})
    this.sessions.set(sessionId, settled)
    void settled.then(() => {
      if (this.sessions.get(sessionId) === settled) this.sessions.delete(sessionId)
    })
    return result
  }

  /** Fence earlier sessions and force every later session to wait for us. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.boundary, ...this.sessions.values()]).then(job)
    this.boundary = result.then(() => {}, () => {})
    return result
  }

  private async compensate(error: unknown, rollback: () => Promise<void>): Promise<never> {
    try {
      await rollback()
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], 'Trash operation and compensation failed', { cause: error })
    }
    throw error
  }

  private workspaceRegistry(): WorkspaceRegistry {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      throw new Error('TrashService requires workspaceRegistry')
    }
    return registry
  }
}
