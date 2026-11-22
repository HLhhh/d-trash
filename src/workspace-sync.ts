import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface ArchiveSnapshot {
  readonly archivedSessionIds: readonly SessionId[]
  readonly pinnedSessionIds: readonly SessionId[]
}

/** Installed 0.2.2-rc.5 exposes the model itself as workspaces.list. */
export interface WorkspaceProjection {
  getSnapshot(): ArchiveSnapshot
  subscribe(listener: () => void): () => void
  replaceArchived(ids: readonly SessionId[]): void
  replacePinned(ids: readonly SessionId[]): void
}

export interface WorkspaceReader {
  follow(signal: AbortSignal): AsyncIterable<{ type: string; value?: ArchiveSnapshot }>
}

const signature = (snapshot: ArchiveSnapshot): string =>
  JSON.stringify([snapshot.archivedSessionIds, snapshot.pinnedSessionIds])

/**
 * Read a fresh follow opening baseline, then install only archive/pin sets.
 * Never issue a Workspace business write to echo a Trash operation. The
 * native stream can deliver older frames after our read; changes to these
 * sets trigger another authoritative read, rather than replaying an intent.
 */
export class WorkspaceSync {
  private generation = 0
  private running?: Promise<void>
  private active?: AbortController
  private disposed = false
  private observed: string
  private readonly unsubscribe: () => void

  constructor(private readonly projection: WorkspaceProjection, private readonly remote: WorkspaceReader) {
    if (typeof projection.replaceArchived !== 'function' || typeof projection.replacePinned !== 'function') {
      throw new Error('Trash requires the Workspace model archive projection capability')
    }
    this.observed = signature(projection.getSnapshot())
    this.unsubscribe = projection.subscribe(() => {
      const next = signature(projection.getSnapshot())
      if (next === this.observed) return
      this.observed = next
      // Background failures retry on the next frame, action or panel refresh.
      // Explicit callers still receive refresh failures in their action UI.
      void this.refresh().catch(() => {})
    })
  }

  /** A newly invoked mutation supersedes any baseline already in flight. */
  invalidate(): void { this.generation++ }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.invalidate()
    if (!this.running) {
      const running = this.readUntilCurrent().finally(() => {
        if (this.running === running) this.running = undefined
      })
      this.running = running
    }
    return this.running
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
    this.unsubscribe()
    this.active?.abort()
  }

  private async readUntilCurrent(): Promise<void> {
    while (!this.disposed) {
      const generation = this.generation
      const controller = new AbortController()
      this.active = controller
      const iterator = this.remote.follow(controller.signal)[Symbol.asyncIterator]()
      try {
        const frame = await iterator.next()
        if (this.disposed) return
        if (generation !== this.generation) continue
        if (frame.done || frame.value.type !== 'baseline' || !frame.value.value) {
          throw new Error('Workspace refresh ended without an opening baseline')
        }
        const baseline = frame.value.value
        const current = this.projection.getSnapshot()
        // Record before installation: the model batches its notifications.
        this.observed = signature(baseline)
        if (JSON.stringify(current.archivedSessionIds) !== JSON.stringify(baseline.archivedSessionIds)) {
          this.projection.replaceArchived(baseline.archivedSessionIds)
        }
        if (JSON.stringify(current.pinnedSessionIds) !== JSON.stringify(baseline.pinnedSessionIds)) {
          this.projection.replacePinned(baseline.pinnedSessionIds)
        }
      } finally {
        controller.abort()
        await iterator.return?.()
        if (this.active === controller) this.active = undefined
      }
      if (generation === this.generation) return
    }
  }
}
