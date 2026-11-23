// Installed rc.5 sources are read/transpiled in memory; all sessions are synthetic.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const ts = require('typescript')

module.exports = async function reappearEvidence(installed, emit) {
  const { fixture } = await import('./phase4-fixture.mjs')
  const { Context } = installed('@deepseek-ai/cordis')
  const { TypertGatewayService } = installed('@deepseek-ai/dsh-api-gateway')
  const assembly = installed('@deepseek-ai/dsh-api-remotes')
  const cache = new Map(), fingerprints = []
  // This browser utility is not shipped as a resolvable package in Desktop.
  // Only generic storage/notification plumbing is a seam; the catalog,
  // mutations, projection, event pump and tree derivation are installed code.
  const store = {
    notifySubscribers(listeners) { for (const fn of listeners) fn() },
    createSnapshotStore(initial) {
      let value = initial
      const listeners = new Set()
      return { getSnapshot: () => value,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        set(next) { value = next; store.notifySubscribers(listeners) },
      }
    },
  }
  function inspect(pkg, relative) {
    const file = path.join(path.dirname(installed.resolve(`@deepseek-ai/${pkg}/package.json`)), relative)
    const contents = fs.readFileSync(file, 'utf8')
    fingerprints.push({ file, sha256: createHash('sha256').update(contents).digest('hex') })
    return contents
  }
  assert.match(inspect('dsh-api-session-controller', 'src/types.ts'),
    /'api-session\/removed'\(sessionId: SessionId\): void/)
  assert.match(inspect('dsh-api-remotes', 'src/index.ts'), /ctx\.on\(event as never/)
  inspect('dsh-api-remotes', 'src/remote-events.ts')
  inspect('dsh-api-gateway', 'src/index.ts')
  assert.match(inspect('dsh-client-ui-workspace', 'src/client/rows/Rows.tsx'),
    /row\.workspaceId === undefined \? t\('group\.ungrouped'\)/)
  assert.match(inspect('dsh-client-ui-workspace', 'src/client/locales.ts'), /'group\.ungrouped': '未分组'/)
  function source(pkg, relative) {
    return load(path.join(path.dirname(installed.resolve(`@deepseek-ai/${pkg}/package.json`)), relative))
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const contents = fs.readFileSync(file, 'utf8')
    fingerprints.push({ file, sha256: createHash('sha256').update(contents).digest('hex') })
    const module = { exports: {} }
    cache.set(file, module)
    const js = ts.transpileModule(contents, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText
    vm.runInThisContext(`(function(require, module, exports) {${js}\n})`, { filename: file })(
      id => id === '@deepseek-ai/dsh-client-store' ? store
        : id.startsWith('.') ? load(path.resolve(path.dirname(file), id)) : installed(id), module, module.exports)
    return module.exports
  }
  const clientEntry = source('dsh-api-session-controller', 'src/client/index.ts')
  const { ClientRemoteEvents } = source('dsh-api-gateway', 'src/client/remote-events.ts')
  const { ClientWorkspaceModel } = source('dsh-api-workspace-controller', 'src/client/model.ts')
  const { deriveGroups, visibleSessionIds, UNGROUPED_KEY } = source('dsh-client-ui-workspace', 'src/client/tree.ts')
  assert.ok(assembly.API_REMOTE_FORWARDED_EVENTS.some(entry => entry.event === 'api-session/removed' && entry.mode === 'emit'))
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000
    while (!predicate()) { assert.ok(Date.now() < deadline, 'installed event delivery timed out'); await tick() }
  }

  for (const branch of ['physical', 'ghost', 'failed', 'deferred']) {
    const ghost = branch === 'ghost'
    const f = await fixture(undefined, { start: true }), client = new Context(), stop = new AbortController()
    let releaseFrame, paused = false, generation, ready = false
    let pump, pumping
    const wire = [], gate = new Promise(resolve => { releaseFrame = resolve })
    try {
      await f.create()
      if (ghost) await fs.promises.rm(f.directory('a'), { recursive: true })
      let callerTrash
      await f.ctx.plugin(ctx => {
        assert.notEqual(ctx.fiber, f.ctx.fiber)
        callerTrash = ctx.get('trash')
      })
      f.ctx.provide('remoteAccess', {})
      const gateway = new TypertGatewayService(f.ctx, { websocketHeartbeatIntervalMs: 2000,
        streamInboxBytes: 100000, websocketCompression: 'none' })
      await f.ctx.plugin(assembly) // actual allowlist listeners; sibling to Trash
      const connection = {
        generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
        registerGenerationSource(run) { generation = run; return () => {} },
      }
      pump = new ClientRemoteEvents(client, connection, async function* (endpoint, payload, signal) {
        const frames = await gateway.wireStream.open(endpoint, payload, (async function* () {})(),
          { principal: { kind: 'owner' }, interactions: 'answer', signal: stop.signal }, signal)
        for await (const frame of frames) {
          // Carrier seam: lossless JSON transport with a controlled delivery delay.
          const copy = JSON.parse(JSON.stringify(frame))
          wire.push(copy)
          if (copy.type === 'emit' && copy.event === 'api-session/removed') {
            paused = true
            await gate
          }
          yield copy
        }
      })
      client.provide('connection', connection)
      client.provide('typert', { contexts: { registerClient() {} } })
      client.provide('remote', { $on: (key, listener) => pump.subscribe(client, key, listener),
        $stream: () => ({}), session: {}, commands: {}, subagents: {} })
      clientEntry.apply(client) // actual $on registration and ClientSessions
      const sessions = client.sessions
      let notifications = 0
      sessions.list.subscribe(() => { notifications++ })
      sessions.handleSessionAdded({ sessionId: 'a', blank: false, running: false, updatedAt: 1 })
      await tick()
      const model = new ClientWorkspaceModel({})
      const workspace = () => ({ workspaceId: 'synthetic-workspace', path: '/synthetic', title: 'Synthetic',
        createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [...f.members] })
      const refreshWorkspace = () => {
        model.upsertView(workspace())
        model.replaceArchived([...f.archived])
      }
      const groups = () => {
        const state = model.getSnapshot()
        return deriveGroups(sessions.list.getSnapshot(), state.items,
          { ...state, archivedFilter: 'default' }, new Map(),
          { expandedGroups: ['synthetic-workspace', UNGROUPED_KEY] })
      }
      refreshWorkspace()
      assert.deepEqual(visibleSessionIds(sessions.list.getSnapshot(), [...f.archived], 'default'), [])
      pumping = generation(stop.signal, () => { ready = true })
      await waitFor(() => ready)
      // Real plugin deletion emits to the real Host assembly/Gateway. Hold its
      // wire frame so old behavior remains observable after all durable cleanup.
      if (branch === 'failed' || branch === 'deferred') {
        const { acquireWriteLease } = await import('../dist/write-lease.js')
        const lease = branch === 'deferred' ? await acquireWriteLease(f.directory('a')) : undefined
        if (branch === 'failed') f.hooks.stat = () => { throw new Error('synthetic stat failure') }
        try { await assert.rejects(callerTrash.removeFromTrash('a'), branch === 'deferred' ? /D_TRASH_DEFERRED/ : /\[gate\]/) }
        finally { await lease?.release() }
        await tick()
        assert.deepEqual(wire.filter(frame => frame.type === 'emit'), [])
        assert.deepEqual(sessions.list.getSnapshot().ids, ['a'])
        assert.ok(sessions.list.getSnapshot().byId.a)
        assert.deepEqual(visibleSessionIds(sessions.list.getSnapshot(), [...f.archived], 'show'), ['a'])
        assert.equal(f.medium.has('a'), true)
        assert.equal(f.members.has('a'), true)
        emit('reappear-installed-catalog', { branch, noRemovedFrame: true, catalogRetainsRow: true })
        continue
      }
      assert.equal(await callerTrash.removeFromTrash('a'), true)
      await waitFor(() => paused)
      assert.equal(f.medium.has('a'), false)
      await assert.rejects(fs.promises.lstat(f.directory('a')), { code: 'ENOENT' })
      refreshWorkspace()
      assert.deepEqual(sessions.list.getSnapshot().ids, ['a'], 'bug reproduction: stale catalog row before delivery')
      assert.deepEqual(groups().find(group => group.key === UNGROUPED_KEY).sessions.map(row => row.id), ['a'])
      const before = notifications
      releaseFrame()
      await waitFor(() => sessions.list.getSnapshot().ids.length === 0)
      assert.equal(sessions.list.getSnapshot().byId.a, undefined)
      assert.equal(groups().some(group => group.sessions.some(row => row.id === 'a')), false)
      assert.equal(groups().some(group => group.key === UNGROUPED_KEY), false)
      assert.ok(notifications > before, 'actual catalog subscription invalidates UI')
      assert.deepEqual(wire.filter(frame => frame.type === 'emit'),
        [{ type: 'emit', event: 'api-session/removed', args: ['a'] }])
      emit('reappear-installed-catalog', { branch,
        beforeDelivery: { ids: ['a'], ungrouped: ['a'] }, afterDelivery: { ids: [], ungrouped: [] },
        realHostGateway: true, realClientEventPump: true, realClientCatalog: true,
        realWorkspaceModelAndTree: true, subscribersNotified: true })
    } finally {
      releaseFrame()
      stop.abort()
      await pumping
      await pump?.dispose()
      await client.fiber.dispose()
      await f.dispose()
    }
  }
  emit('reappear-installed-source', { dsh: installed('@deepseek-ai/dsh/package.json').version,
    seam: 'generic browser snapshot/notification utility and in-process JSON carrier only',
    fingerprints: fingerprints.filter(row => /dsh-api-remotes|dsh-api-gateway.*src[\\/]index\.ts$|remote-events\.ts$|sessions\/(?:service|manager)\.ts$|client\/(?:index|tree)\.ts$/.test(row.file)) })
}
