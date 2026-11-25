import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { DistillAgentPreset } from './types.js'
import { abortable, parseDistillOutput, type DistillExecutor, type DistillReader } from './distill.js'

// Narrow public service bridges verified against the installed rc.5 exports.
// Optional lookups keep trash usable in deployments without an Agent factory.
interface PresetRegistry {
  list(): Promise<Array<{ id: string; name?: string; broken?: string }>>
  mount(ctx: Context, id: string): Promise<unknown>
}
interface TaskAgent {
  id: SessionId
  session: Session
  send(message: { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' } }, target: 'next-turn', wakeup: boolean): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'disposed' }): void
}
interface AgentHandle { agent: TaskAgent; dispose(): Promise<void> }
interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
interface AgentRegistry {
  create(options: { sessionId: SessionId; agentOptions: ModelSelection; meta: { cwd: string; agentPreset: string }; signal: AbortSignal;
    setup(ctx: Context, agent: TaskAgent): Promise<void> }): Promise<AgentHandle>
}
interface TaskTools {
  restrict(filter: { allow: readonly string[] }): () => void
  guard(guard: () => string): () => void
}
interface RuntimeLookup {
  get(name: 'agentDefaultModel'): { currentSelection(): ModelSelection } | undefined
  get(name: 'agents'): AgentRegistry | undefined
  get(name: 'agentPresets'): PresetRegistry | undefined
  get(name: 'tools'): TaskTools | undefined
}
const lookup = (ctx: Context): RuntimeLookup => ctx as unknown as RuntimeLookup

export async function listDistillAgents(ctx: Context): Promise<DistillAgentPreset[]> {
  const runtime = lookup(ctx)
  const presets = runtime.get('agentPresets')
  if (!presets || !runtime.get('agents') || !runtime.get('agentDefaultModel')) return [{ id: '__manual__', name: '' }]
  return [...(await presets.list()).filter(row => !row.broken).map(row => ({ id: row.id, name: row.name ?? row.id })),
    { id: '__manual__', name: '' }]
}

/** Only a read handle; the detached Session is never entered into a store. */
export function sessionReader(persistence: () => SessionPersistence, home: (id: SessionId) => Promise<string>): DistillReader {
  return async (id, signal) => {
    const handle = await persistence().open(id, 'read', { signal })
    try {
      const { events } = await handle.read(undefined, undefined, { signal })
      signal.throwIfAborted()
      const detached = Session.create(id, events, handle.header, handle.inheritedEventCount)
      // Keep the full visible transcript, including tools, as JSON. Do not
      // read attachments, files, environment, or hidden provider replay state.
      const transcript = JSON.stringify(detached.deriveMessages().map(message => ({
        role: message.role, content: message.content,
      })))
      if (transcript === '[]') throw new Error('Session contains no messages')
      const title = [...events as readonly { type: string; data: unknown }[]].reverse().find(event => event.type === 'session/title')?.data
      return { id, title: title && typeof title === 'object' && 'title' in title && typeof title.title === 'string' ? title.title : id,
        createdAt: handle.header.createdAt, cwd: handle.header.cwd, transcript,
        protectedHome: await home(id) }
    } finally { await handle.close() }
  }
}

/** New isolated execution identity; never resolveAgent or resume the source. */
export function agentExecutor(ctx: Context): DistillExecutor {
  return { async run(presetId, prompt, cwd, signal) {
    const runtime = lookup(ctx)
    const agents = runtime.get('agents'), presets = runtime.get('agentPresets')
    if (!agents || !presets) throw new Error('Agent/preset services unavailable; use manual prompt export')
    if (!(await presets.list()).some(row => row.id === presetId && !row.broken)) throw new Error('Agent preset is unavailable')
    const route = runtime.get('agentDefaultModel')?.currentSelection()
    if (!route?.provider || !route.model) throw new Error('DSH default model is unavailable; use manual prompt export')
    const taskId = randomUUID() as SessionId
    let end: { kind: string; error?: unknown } | undefined
    let handle: AgentHandle | undefined
    // create() can settle after cancellation. Always dispose a late handle.
    const creating = agents.create({ sessionId: taskId, agentOptions: route, meta: { cwd, agentPreset: presetId }, signal,
      async setup(childCtx, agent) {
        signal.throwIfAborted()
        const tools = lookup(childCtx).get('tools')
        if (!tools) throw new Error('Scoped tool restriction service is unavailable')
        tools.restrict({ allow: [] })
        tools.guard(() => 'Distillation is read-only: all tool execution is disabled')
        await presets.mount(childCtx, presetId)
        signal.throwIfAborted()
        childCtx.on('session/event', (session, event) => {
          if (session.id === taskId && event.type === 'turn/end') end = event.data.reason
        })
      },
    })
    void creating.then(late => {
      if (signal.aborted) {
        try { late.agent.cancel({ kind: 'disposed' }) }
        finally { void late.dispose().catch(() => {}) }
      }
    }).catch(() => {})
    const cancel = () => { try { handle?.agent.cancel({ kind: 'disposed' }) } catch { /* disposal still attempted */ } }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      handle = await abortable(creating, signal)
      signal.throwIfAborted()
      handle.agent.send({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }, 'next-turn', true)
      await abortable(handle.agent.whenIdle(), signal)
      signal.throwIfAborted()
      if (end?.kind !== 'completed') throw new Error(`Agent turn did not complete: ${JSON.stringify(end ?? { kind: 'missing-turn-end' })}`)
      const messages = handle.agent.session.deriveMessages()
      const last = [...messages].reverse().find(message => message.role === 'assistant' && message.content.length > 0)
      const blocks = last?.content as readonly { type: string; text?: string }[] | undefined
      const text = blocks?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
      if (!text) throw new Error('Agent produced no final text')
      return parseDistillOutput(text)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (handle) {
        const disposing = handle.dispose()
        // Normal success waits for owned cleanup; cancellation never holds up
        // Trash shutdown on a provider that ignores its abort signal.
        if (signal.aborted) void disposing.catch(() => {})
        else await abortable(disposing, signal)
      }
    }
  } }
}
