import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import TrashService, { Config } from '../dist/index.js'
import { SessionDistiller, parseDistillOutput } from '../dist/distill.js'
import { sessionReader, agentExecutor, listDistillAgents } from '../dist/distill-host.js'
import { Session } from '@deepseek-ai/dsh-session'
import { copy } from '../dist/client-copy.js'

let count = 0
async function test(name, job) { await job(); count++; console.log(`PASS: distill: ${name}`) }
const tick = () => new Promise(resolve => setImmediate(resolve))
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture({ reader, executor, directory } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'trash-distill-')))
  const home = join(root, 'home'), cwd = join(root, 'work')
  await mkdir(cwd); await mkdir(join(home, 'sessions', 'project', 'a'), { recursive: true })
  await writeFile(join(home, 'sessions', 'project', 'a', 'session.v4.jsonl'), 'synthetic source log\n')
  await writeFile(join(home, 'sessions', 'project', 'a', 'session.lock'), '')
  const medium = new Map(['a', 'b'].map(id => [id, { trashedAt: 1 }]))
  const archived = new Set(['a', 'b']), members = new Set(['a', 'b'])
  const markers = JSON.stringify([...medium]), registry = JSON.stringify([[...archived], [...members]])
  await writeFile(join(home, 'markers.json'), markers); await writeFile(join(home, 'registry.json'), registry)
  const protectedFiles = ['markers.json', 'registry.json', 'sessions/project/a/session.v4.jsonl', 'sessions/project/a/session.lock']
  const hashes = async () => Promise.all(protectedFiles.map(async f => createHash('sha256').update(await readFile(join(home, f))).digest('hex')))
  const before = await hashes()
  const ctx = new Context()
  ctx.provide('storageDomain', { async open() { return { table: () => ({
    get: id => medium.get(id), entries: () => medium.entries(), keys: () => medium.keys(),
    put() { assert.fail('distill cannot write markers') }, delete() { assert.fail('distill cannot delete markers') },
    deleteMany() { assert.fail('distill cannot reconcile markers') },
  }), async close() {} } } })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [...archived], list: () => [{ sessionIds: [...members] }],
    archiveSession() { assert.fail('archive write') }, unarchiveSession() { assert.fail('unarchive write') } })
  ctx.provide('sessionPersistence', { async stat(id) { return { header: { id }, location: { kind: 'jsonl', path: join(home, 'sessions', 'project', 'a', 'session.v4.jsonl') } } },
    async list() { return [] }, open() { assert.fail('Injected reader must be used') }, create() { assert.fail('No real task creation in tests') } })
  ctx.provide('agents', { resume() { assert.fail('resume forbidden') }, create() { assert.fail('real model forbidden') } })
  const source = id => ({ id, title: `Title ${id}`, createdAt: 1, cwd, protectedHome: home, transcript: `Transcript ${id}` })
  const trash = new TrashService(ctx, { distillDir: directory?.(root) ?? '' }, {
    reader: reader ? (id, signal) => reader(id, signal, source) : async id => source(id),
    executor: executor ?? { async run(id, prompt) { return { type: 'experience', body: `## Summary\n${id}\n${prompt.includes('Transcript a') ? 'A result' : 'B result'}` } } },
  })
  return { root, home, cwd, ctx, trash, medium, archived, members, hashes, before, source,
    async close() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}

await test('success metadata, readonly markers/archive/membership/log hashes, audit stages and no write lease', async () => {
  const f = await fixture()
  // A real writer lease may coexist with distillation; the plugin never takes one.
  const { acquireWriteLease } = await import('../dist/write-lease.js')
  const lease = await acquireWriteLease(join(f.home, 'sessions', 'project', 'a'))
  try {
    const result = await f.trash.distillSession('a', 'preset-A')
    assert.equal(result.mode, 'agent'); assert.match(result.path, /\d{4}-\d{2}-\d{2}-a-distill\.md$/)
    const md = await readFile(result.path, 'utf8')
    for (const field of ['Session ID: "a"', 'Title: "Title a"', 'Session time:', 'Generated at:', 'Distillation type: experience', 'preset-A', '## Summary', 'A result']) assert.ok(md.includes(field), field)
    assert.deepEqual(await f.hashes(), f.before)
    assert.deepEqual([...f.medium], [['a', { trashedAt: 1 }], ['b', { trashedAt: 1 }]])
    assert.deepEqual([...f.archived], ['a', 'b']); assert.deepEqual([...f.members], ['a', 'b'])
    const audit = (await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(audit.map(x => [x.action, x.stage, x.result]), [['distill', 'started', 'ok'], ['distill', 'completed', 'ok']])
    await lease.verify()
  } finally { await lease.release(); await f.close() }
})
await test('read failure is staged, audited and retryable', async () => {
  let fail = true
  const f = await fixture({ reader: async (id, signal, source) => { if (fail) throw Error('read failure'); return source(id) } })
  try {
    await assert.rejects(f.trash.distillSession('a', 'p'), /Distill \[read\].*read failure/)
    fail = false; assert.equal((await f.trash.distillSession('a', 'p')).mode, 'agent')
    const audit = await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')
    assert.match(audit, /"stage":"failed".*Distill \[read\]/)
    assert.deepEqual(await f.hashes(), f.before)
  } finally { await f.close() }
})
await test('agent failure writes no artifact and can retry with another preset', async () => {
  let fail = true
  const f = await fixture({ executor: { async run(preset) { if (fail) throw Error('provider failed'); return { type: 'requirements', body: preset } } } })
  try {
    await assert.rejects(f.trash.distillSession('a', 'bad'), /Distill \[agent\].*provider failed/)
    assert.deepEqual(await readdir(f.cwd), [])
    fail = false; assert.match(await readFile((await f.trash.distillSession('a', 'good')).path, 'utf8'), /good/)
  } finally { await f.close() }
})
await test('same session serializes, different sessions overlap and outputs do not mix or overwrite', async () => {
  const hold = barrier(), firstStarted = barrier(), started = []
  const f = await fixture({ executor: { async run(preset) { started.push(preset); if (preset === 'a1') { firstStarted.resolve(); await hold.promise }; return { type: 'operations', body: preset } } } })
  try {
    const a1 = f.trash.distillSession('a', 'a1'); await firstStarted.promise; const a2 = f.trash.distillSession('a', 'a2'); const b = f.trash.distillSession('b', 'b')
    const bResult = await b
    assert.deepEqual(started, ['a1', 'b']); assert.match(await readFile(bResult.path, 'utf8'), /\n\nb\n$/)
    hold.resolve(); const [one, two] = await Promise.all([a1, a2]); assert.notEqual(one.path, two.path)
    assert.match(await readFile(one.path, 'utf8'), /\n\na1\n$/); assert.match(await readFile(two.path, 'utf8'), /\n\na2\n$/)
    assert.deepEqual(started, ['a1', 'b', 'a2'])
  } finally { hold.resolve(); await f.close() }
})
await test('unload cancels active and queued tasks even if injected executor never settles', async () => {
  const started = barrier()
  const f = await fixture({ executor: { async run() { started.resolve(); return new Promise(() => {}) } } })
  try {
    const first = f.trash.distillSession('a', 'p').catch(e => e)
    const queued = f.trash.distillSession('a', 'q').catch(e => e)
    await started.promise
    await Promise.race([f.ctx.fiber.dispose(), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Unload blocked')), 1000); timer.unref() })])
    assert.match(String(await first), /unloading/); assert.match(String(await queued), /unloading/)
    await assert.rejects(f.trash.distillSession('b', 'p'), /unloading/)
    assert.deepEqual(await readdir(f.cwd), [])
  } finally { await f.close() }
})
await test('manual export is explicitly a prompt, never calls an executor', async () => {
  const f = await fixture({ executor: { run() { assert.fail('manual mode cannot run a model') } } })
  try {
    const result = await f.trash.distillSession('a', '__manual__')
    assert.equal(result.mode, 'prompt'); assert.match(await readFile(result.path, 'utf8'), /not a completed distillation/)
  } finally { await f.close() }
})
await test('configured directory, unsafe output rejection and missing cwd diagnosis', async () => {
  assert.equal(Config({}).distillDir, '')
  for (const variant of ['configured', 'home', 'relative', 'missing', 'symlink']) {
    const f = await fixture({ directory: root => variant === 'home' ? join(root, 'home', 'sessions', 'out') : variant === 'relative' ? 'relative' : variant === 'configured' ? join(root, 'exports') : '',
      reader: async (id, signal, source) => ({ ...source(id), ...(variant === 'missing' ? { cwd: undefined } : {}) }) })
    try {
      if (variant === 'symlink') await symlink(f.home, join(f.cwd, 'd-trash-distill'), process.platform === 'win32' ? 'junction' : 'dir')
      if (variant === 'configured') assert.ok((await f.trash.distillSession('a', 'p')).path.startsWith(join(f.root, 'exports')))
      else await assert.rejects(f.trash.distillSession('a', 'p'), /Distill \[path\]/)
      assert.deepEqual(await f.hashes(), f.before)
    } finally { await f.close() }
  }
})
await test('production reader opens read only, closes on decode failure and never enters/resumes a Session', async () => {
  const detached = Session.create('read-fixture')
  detached.append('user/message', { id: 'm', role: 'user', content: [{ type: 'text', text: 'Body' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  let closed = 0, fail = false
  const reader = sessionReader(() => ({ async open(id, access) {
    assert.equal(id, 'read-fixture'); assert.equal(access, 'read')
    return { header: detached.header, inheritedEventCount: 0,
      async read() { if (fail) throw Error('decode failed'); return { events: detached.snapshotEvents() } }, async close() { closed++ } }
  } }), async () => '/synthetic/home')
  const source = await reader('read-fixture', new AbortController().signal)
  assert.match(source.transcript, /Body/); assert.equal(closed, 1)
  fail = true; await assert.rejects(reader('read-fixture', new AbortController().signal), /decode failed/); assert.equal(closed, 2)
})
await test('wire fallback and bilingual keys are explicit; malformed agent output refuses', async () => {
  assert.deepEqual(await listDistillAgents({ get() {} }), [{ id: '__manual__', name: '' }])
  const services = { agentDefaultModel: {}, agents: {}, agentPresets: { async list() { return [{ id: 'one', name: 'One' }, { id: 'two' }, { id: 'bad', broken: 'broken' }] } } }
  assert.deepEqual(await listDistillAgents({ get: name => services[name] }), [{ id: 'one', name: 'One' }, { id: 'two', name: 'two' }, { id: '__manual__', name: '' }])
  for (const key of Object.keys(copy.en).filter(key => key.startsWith('distill'))) { assert.ok(copy.en[key]); assert.ok(copy.zh[key]); assert.notEqual(copy.en[key], copy.zh[key]) }
  assert.deepEqual(parseDistillOutput('```json\n{"type":"skill-draft","body":"## Skill"}\n```'), { type: 'skill-draft', body: '## Skill' })
  assert.throws(() => parseDistillOutput('{"type":"fake","body":""}'), /invalid/)
})
console.log(`PASS: distill ${count} groups (injected execution only; no real model or source resume)`)

await test('production agent adapter selects preset, restricts and guards tools, waits, collects final JSON and disposes its independent identity', async () => {
  const idle = barrier(), sent = barrier(), events = [], calls = [], ids = []
  let completionKind = 'completed'
  const session = { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '{"type":"experience","body":"## Done"}' }] }] }
  const child = { get(name) { assert.equal(name, 'tools'); return {
    restrict(filter) { assert.deepEqual(filter, { allow: [] }); calls.push('restrict') },
    guard(fn) { assert.match(fn(), /disabled/); calls.push('guard') },
  } }, on(name, callback) { assert.equal(name, 'session/event'); events.push(callback) } }
  const services = {
    agentDefaultModel: { currentSelection() { return { provider: 'injected-provider', model: 'injected-model' } } },
    agentPresets: { async list() { return [{ id: 'chosen' }] }, async mount(ctx, id) { assert.equal(ctx, child); assert.equal(id, 'chosen'); calls.push('mount') } },
    agents: { resume() { assert.fail('resume forbidden') }, async create(options) {
      assert.deepEqual(options.agentOptions, { provider: 'injected-provider', model: 'injected-model' })
      ids.push(options.sessionId); assert.notEqual(options.sessionId, 'source')
      assert.equal(options.meta.agentPreset, 'chosen'); assert.equal(options.meta.cwd, '/synthetic/work')
      assert.equal(options.seed, undefined)
      const agent = { session,
        send(message, target, wakeup) { assert.equal(message.content[0].text, 'prompt'); assert.equal(target, 'next-turn'); assert.equal(wakeup, true); calls.push('send'); sent.resolve() },
        async whenIdle() { await idle.promise; events.forEach(fn => fn({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: completionKind } } })) },
        cancel() { calls.push('cancel') },
      }
      await options.setup(child, agent)
      return { agent, async dispose() { calls.push('dispose') } }
    } },
  }
  const executor = agentExecutor({ get: name => services[name] })
  const output = executor.run('chosen', 'prompt', '/synthetic/work', new AbortController().signal)
  await sent.promise; assert.deepEqual(calls, ['restrict', 'guard', 'mount', 'send'])
  idle.resolve(); assert.deepEqual(await output, { type: 'experience', body: '## Done' }); assert.equal(calls.at(-1), 'dispose')
  await executor.run('chosen', 'prompt', '/synthetic/work', new AbortController().signal)
  assert.notEqual(ids[0], ids[1])
  completionKind = 'error'
  await assert.rejects(executor.run('chosen', 'prompt', '/synthetic/work', new AbortController().signal), /did not complete.*error/)
  assert.equal(calls.at(-1), 'dispose')
})
await test('production agent adapter disposes cancelled late creations', async () => {
  let disposeCount = 0
  const created = barrier(), signal = new AbortController()
  const lateHandle = { agent: { cancel() {}, send() { assert.fail('no send after cancellation') } }, async dispose() { disposeCount++ } }
  const executor = agentExecutor({ get(name) { return name === 'agentDefaultModel' ? { currentSelection() { return { provider: 'fake', model: 'fake' } } } : name === 'agentPresets' ? { async list() { return [{ id: 'p' }] } } : { create: () => created.promise } } })
  const task = executor.run('p', 'prompt', '/work', signal.signal)
  await tick(); signal.abort(Error('cancelled')); await assert.rejects(task, /cancelled/)
  created.resolve(lateHandle); await tick(); assert.equal(disposeCount, 1)
})
await test('gate rejects pending and unarchived rows without changing markers; audit failure cannot change success', async () => {
  const f = await fixture()
  try {
    f.medium.get('a').purge = { source: 'pending' }
    await assert.rejects(f.trash.distillSession('a', 'p'), /\[gate\]/)
    delete f.medium.get('a').purge
    f.ctx.get('workspaceRegistry').archivedSessionIds = []
    await assert.rejects(f.trash.distillSession('a', 'p'), /\[gate\]/)
    f.ctx.get('workspaceRegistry').archivedSessionIds = ['a', 'b']
    f.trash.operationLog.locateHome = async () => { throw Error('audit unavailable') }
    f.trash.operationLog.home = undefined
    f.trash.operationLog.fallback = () => { throw Error('fallback logger unavailable') }
    assert.equal((await f.trash.distillSession('a', 'p')).mode, 'agent')
  } finally { await f.close() }
})
console.log(`PASS: distill total ${count} groups`)
