// Installed rc.5 evidence: real JSONL + Session + scoped tools + Registry.
// Only synthetic temporary home, declarations and injected factory; no model.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
module.exports = async (installed, emit) => {
  const { Context } = installed('@deepseek-ai/cordis')
  const { AgentRegistry } = installed('@deepseek-ai/dsh-agent')
  const { Session } = installed('@deepseek-ai/dsh-session')
  const { createUserMessage } = installed('@deepseek-ai/dsh-llm')
  const persistencePlugin = installed('@deepseek-ai/dsh-session-persistence-jsonl')
  const { AgentPresetRegistry } = installed('@deepseek-ai/dsh-agent-preset-registry')
  const { createScope, scopeTarget } = installed('@deepseek-ai/dsh-scope')
  const Tools = installed('@deepseek-ai/dsh-tools').default
  const { AgentDefaultModelConfig } = installed('@deepseek-ai/dsh-agent-default-model')
  const { sessionReader, agentExecutor, listDistillAgents } = await import('../dist/distill-host.js')
  const ctx = new Context()
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trash-p53-evidence-')))
  let writer, scope
  try {
    await persistencePlugin.apply(ctx, { root: path.join(root, 'sessions'), compression: 'none' })
    const persistence = ctx.get('sessionPersistence')
    const base = Session.create('synthetic-source')
    const seed = Session.create(base.id, undefined, { ...base.header, cwd: root })
    seed.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Synthetic transcript' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    writer = await persistence.create(seed.header)
    await writer.append(seed.snapshotEvents()); await writer.flush()
    const snapshot = await persistence.stat(seed.id)
    const before = fs.readFileSync(snapshot.location.path)
    const result = await sessionReader(() => persistence, async () => root)(seed.id, new AbortController().signal)
    assert.match(result.transcript, /Synthetic transcript/)
    await assert.rejects(persistence.open(seed.id, 'write'))
    assert.deepEqual(fs.readFileSync(snapshot.location.path), before)
    emit('p53-installed-read', { realJsonl: true, productionReader: true, readWhileWriter: true, detachedDeriveMessages: true, logUnchanged: true })
    await writer.close(); writer = undefined

    ctx.provide('systemPrompt', { tools() {} })
    new Tools(ctx)
    const scopeKey = {}
    scope = createScope(ctx, scopeKey)
    scope.ctx.get('tools').restrict({ allow: [] })
    scope.ctx.get('tools').guard(() => 'distill denies all tools')
    const denial = ctx.get('tools').checkGuards({ agent: scopeKey })
    assert.equal(denial.reason, 'distill denies all tools')
    assert.equal(ctx.get('tools').checkGuards({ agent: {} }), undefined)
    emit('p53-installed-tool-guard', { actualScopedRestriction: true, allExecutionDenied: true, hostUnaffected: true })

    const agents = new AgentRegistry(ctx)
    // Isolate declaration storage; execute the real installed list/diagnostic
    // method. No profile roster, Loader entry or real Agent is read or changed.
    const presets = new AgentPresetRegistry(ctx, { default: 'probe', selectedDefault: { get() {} } })
    presets.definitions.set('probe', { config: { id: 'probe', name: 'Probe preset', plugins: [] }, ready: Promise.resolve() })
    presets.definitions.set('broken', { config: { id: 'broken', name: 'Broken', plugins: [] }, ready: Promise.resolve(), broken: 'injected activation failure' })
    const route = { provider: 'injected-provider', model: 'injected-model' }
    new AgentDefaultModelConfig(ctx, { provider: { get: () => route.provider }, model: { get: () => route.model }, reasoningEffort: { get() {} } })
    let disposed = 0, selected
    // Preset mount is a seam: real composition needs a Loader profile. Its
    // installed mount/bind implementation is inspected, never fabricated.
    const realMount = presets.mount
    presets.mount = async (childCtx, id) => { assert.equal(childCtx, scope.ctx); selected = id }
    let completed
    agents.setFactory({ async createAgent(owner, options) {
      assert.notEqual(options.sessionId, seed.id)
      assert.deepEqual(options.agentOptions, route)
      assert.equal(options.meta.agentPreset, 'probe')
      const task = Session.create(options.sessionId)
      const agent = { id: options.sessionId, session: task,
        send(message, target, wakeup) { assert.equal(target, 'next-turn'); assert.equal(wakeup, true); assert.match(message.content[0].text, /Synthetic transcript/) },
        async whenIdle() {
          // Agent completion is injected; the production executor still waits,
          // handles the public turn event, and parses real derived messages.
          const { createAssistantMessage } = installed('@deepseek-ai/dsh-llm')
          task.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '{"type":"experience","body":"## Probe result"}' }], source: { provider: route.provider, model: route.model } }), stream: [] }, { surfaceOp: 'append' })
          scope.ctx.emit(scopeTarget(task, scopeKey), 'session/event', task, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          completed = true
        }, cancel() {},
      }
      await options.setup(scope.ctx, agent)
      return { agent, async dispose() { disposed++ } }
    }, async resume() { assert.fail('resume forbidden') } })
    const roster = await listDistillAgents(ctx)
    assert.deepEqual(roster, [{ id: 'probe', name: 'Probe preset' }, { id: '__manual__', name: '' }])
    const output = await agentExecutor(ctx).run('probe', result.transcript, root, new AbortController().signal)
    assert.equal(selected, 'probe'); assert.equal(completed, true); assert.equal(disposed, 1)
    assert.deepEqual(output, { type: 'experience', body: '## Probe result' })
    presets.mount = realMount
    emit('p53-installed-agent-dispatch', { realRegistry: true, realRoster: true, actualDefaultModelService: true, selectedPreset: selected,
      factoryAndPresetMount: 'injected; no model or profile', productionExecutor: true, independentIdentity: true, completionAndOutput: true, disposed: true })
  } finally {
    await writer?.close(); await scope?.dispose(); await ctx.fiber.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
}
