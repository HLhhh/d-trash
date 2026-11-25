import { randomUUID } from 'node:crypto';
import { Session } from '@deepseek-ai/dsh-session';
import { abortable, parseDistillOutput } from './distill.js';
const lookup = (ctx) => ctx;
export async function listDistillAgents(ctx) {
    const runtime = lookup(ctx);
    const presets = runtime.get('agentPresets');
    if (!presets || !runtime.get('agents') || !runtime.get('agentDefaultModel'))
        return [{ id: '__manual__', name: '' }];
    return [...(await presets.list()).filter(row => !row.broken).map(row => ({ id: row.id, name: row.name ?? row.id })),
        { id: '__manual__', name: '' }];
}
/** Only a read handle; the detached Session is never entered into a store. */
export function sessionReader(persistence, home) {
    return async (id, signal) => {
        const handle = await persistence().open(id, 'read', { signal });
        try {
            const { events } = await handle.read(undefined, undefined, { signal });
            signal.throwIfAborted();
            const detached = Session.create(id, events, handle.header, handle.inheritedEventCount);
            // Keep the full visible transcript, including tools, as JSON. Do not
            // read attachments, files, environment, or hidden provider replay state.
            const transcript = JSON.stringify(detached.deriveMessages().map(message => ({
                role: message.role, content: message.content,
            })));
            if (transcript === '[]')
                throw new Error('Session contains no messages');
            const title = [...events].reverse().find(event => event.type === 'session/title')?.data;
            return { id, title: title && typeof title === 'object' && 'title' in title && typeof title.title === 'string' ? title.title : id,
                createdAt: handle.header.createdAt, cwd: handle.header.cwd, transcript,
                protectedHome: await home(id) };
        }
        finally {
            await handle.close();
        }
    };
}
/** New isolated execution identity; never resolveAgent or resume the source. */
export function agentExecutor(ctx) {
    return { async run(presetId, prompt, cwd, signal) {
            const runtime = lookup(ctx);
            const agents = runtime.get('agents'), presets = runtime.get('agentPresets');
            if (!agents || !presets)
                throw new Error('Agent/preset services unavailable; use manual prompt export');
            if (!(await presets.list()).some(row => row.id === presetId && !row.broken))
                throw new Error('Agent preset is unavailable');
            const route = runtime.get('agentDefaultModel')?.currentSelection();
            if (!route?.provider || !route.model)
                throw new Error('DSH default model is unavailable; use manual prompt export');
            const taskId = randomUUID();
            let end;
            let handle;
            // create() can settle after cancellation. Always dispose a late handle.
            const creating = agents.create({ sessionId: taskId, agentOptions: route, meta: { cwd, agentPreset: presetId }, signal,
                async setup(childCtx, agent) {
                    signal.throwIfAborted();
                    const tools = lookup(childCtx).get('tools');
                    if (!tools)
                        throw new Error('Scoped tool restriction service is unavailable');
                    tools.restrict({ allow: [] });
                    tools.guard(() => 'Distillation is read-only: all tool execution is disabled');
                    await presets.mount(childCtx, presetId);
                    signal.throwIfAborted();
                    childCtx.on('session/event', (session, event) => {
                        if (session.id === taskId && event.type === 'turn/end')
                            end = event.data.reason;
                    });
                },
            });
            void creating.then(late => {
                if (signal.aborted) {
                    try {
                        late.agent.cancel({ kind: 'disposed' });
                    }
                    finally {
                        void late.dispose().catch(() => { });
                    }
                }
            }).catch(() => { });
            const cancel = () => { try {
                handle?.agent.cancel({ kind: 'disposed' });
            }
            catch { /* disposal still attempted */ } };
            signal.addEventListener('abort', cancel, { once: true });
            try {
                handle = await abortable(creating, signal);
                signal.throwIfAborted();
                handle.agent.send({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }, 'next-turn', true);
                await abortable(handle.agent.whenIdle(), signal);
                signal.throwIfAborted();
                if (end?.kind !== 'completed')
                    throw new Error(`Agent turn did not complete: ${JSON.stringify(end ?? { kind: 'missing-turn-end' })}`);
                const messages = handle.agent.session.deriveMessages();
                const last = [...messages].reverse().find(message => message.role === 'assistant' && message.content.length > 0);
                const blocks = last?.content;
                const text = blocks?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
                if (!text)
                    throw new Error('Agent produced no final text');
                return parseDistillOutput(text);
            }
            finally {
                signal.removeEventListener('abort', cancel);
                if (handle) {
                    const disposing = handle.dispose();
                    // Normal success waits for owned cleanup; cancellation never holds up
                    // Trash shutdown on a provider that ignores its abort signal.
                    if (signal.aborted)
                        void disposing.catch(() => { });
                    else
                        await abortable(disposing, signal);
                }
            }
        } };
}
