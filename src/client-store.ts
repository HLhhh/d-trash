import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TrashRecord } from './types.js'

export type TrashEntries = Array<[SessionId, TrashRecord]>
type Change = { revision: number; apply: (rows: Map<SessionId, TrashRecord>) => void }
export interface WriteTicket { readonly sequence: number; readonly sessionId?: SessionId }

/** Client projection only, from Host reads and accepted successful mutations. */
class TrashStore {
  private entries: TrashEntries | null = null
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private request = 0
  private readonly baselines = new Map<number, number>()
  private changes: Change[] = []
  private sequence = 0
  private emptySequence = 0
  private readonly sessionSequences = new Map<SessionId, number>()

  /** Capture at invocation, shared across menu, hover and every panel. */
  begin(sessionId?: SessionId): WriteTicket {
    const sequence = ++this.sequence
    if (sessionId === undefined) this.emptySequence = sequence
    else this.sessionSequences.set(sessionId, sequence)
    return { sequence, sessionId }
  }

  isCurrent(ticket: WriteTicket): boolean {
    return ticket.sessionId === undefined
      ? ticket.sequence === this.sequence
      : ticket.sequence === this.sessionSequences.get(ticket.sessionId)
        && ticket.sequence > this.emptySequence
  }

  /** Responses carry their invocation ticket, never their arrival order. */
  async accept(ticket: WriteTicket, apply: () => void, load: () => Promise<TrashEntries>): Promise<void> {
    if (this.isCurrent(ticket)) apply()
    else await this.refresh(load, () => true)
  }

  getSnapshot = (): TrashEntries | null => this.entries

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  upsert(sessionId: SessionId, record: TrashRecord): void {
    this.change(rows => { rows.set(sessionId, record) })
  }

  remove(sessionId: SessionId): void {
    this.change(rows => { rows.delete(sessionId) })
  }

  clear(): void {
    this.change(rows => { rows.clear() })
  }

  /** A late list response must not undo mutations committed while it loaded. */
  async refresh(load: () => Promise<TrashEntries>, current: () => boolean): Promise<void> {
    const token = ++this.request
    const revision = this.revision
    this.baselines.set(token, revision)
    try {
      const rows = new Map(await load())
      if (token !== this.request || !current()) return
      for (const change of this.changes) {
        if (change.revision > revision) change.apply(rows)
      }
      this.publish(rows)
    } finally {
      this.baselines.delete(token)
      const earliest = Math.min(...this.baselines.values())
      this.changes = this.changes.filter(change => change.revision > earliest)
    }
  }

  private change(apply: Change['apply']): void {
    const revision = ++this.revision
    if (this.baselines.size) this.changes.push({ revision, apply })
    const rows = new Map(this.entries ?? [])
    apply(rows)
    this.publish(rows)
  }

  private publish(rows: Map<SessionId, TrashRecord>): void {
    this.entries = [...rows].sort((a, b) => b[1].trashedAt - a[1].trashedAt)
    for (const listener of this.listeners) listener()
  }
}

// One browser bundle/module instance, shared by menu, hover action and panels.
export const trashStore = new TrashStore()
