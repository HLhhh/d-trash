// Installed Registry/Domain/Feed/ClientWorkspaceModel, real plugin slot closures.
// Only storage medium, session existence/activity and transport delivery are seams.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const tick = () => new Promise(resolve => setImmediate(resolve))
const text = node => !node || typeof node === 'boolean' ? '' : typeof node !== 'object'
  ? String(node) : (node.children ?? []).map(text).join(' ')

function barrier() {
  let entered, release
  const arrived = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  return { arrived, release, async wait() { entered(); await gate } }
}

module.exports = async function review2fix(installed, emit, evidence) {
  const { Context } = installed('@deepseek-ai/cordis')
  const { WorkspaceRegistry, workspaceDomainSpec } = installed('@deepseek-ai/dsh-workspace')
  const { DomainFacility } = installed('@deepseek-ai/dsh-storage-domain')
  const { DomainImpl, WorkspaceFeed, ClientWorkspaceModel, WorkspaceController, visibleSessionIds, source } = evidence
  const { WorkspaceEntity } = source('dsh-workspace', 'src/entity.ts')
  const TrashService = (await import('../dist/index.js')).default
  const bundle = fs.readFileSync(path.join(__dirname, '../dist/client.js'), 'utf8')
  const releases = new Set()
  const pause = () => { const value = barrier(); releases.add(value.release); return value }

  async function fixture(mode = 'none') {
    const ctx = new Context()
    const hooks = {}, medium = new Map(), calls = [], delivery = [], queued = []
    const records = new Map(['a', 'b'].map(id => [`work-${id}`, {
      path: `/isolated/${id}`, title: `Workspace ${id.toUpperCase()}`,
      sessionIds: id === 'a' ? ['owned-session'] : [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]))
    const initial = { initialized: true, workspaceIds: [...records.keys()], archivedSessionIds: [], pinnedSessionIds: [] }
    const workspaceDomain = new DomainImpl(ctx, workspaceDomainSpec, {
      async setGlobal() {}, async putRecord() {}, async close() {},
    }, new Map([['workspaces', records]]), initial, () => {})
    const entityHost = { table: () => workspaceDomain.table('workspaces'), candidateMatches: () => true }
    const entities = new Map([...records].map(([id, record]) => [id, new WorkspaceEntity(entityHost, id, record)]))
    const registry = Object.create(WorkspaceRegistry.prototype)
    Object.defineProperty(registry, 'ctx', { value: ctx })
    Object.assign(registry, { state: initial, global: workspaceDomain.global, entities,
      operationTail: Promise.resolve(), sessionKnown: async () => true, stopSessionActivity: async () => {},
    })
    for (const method of ['archiveSession', 'unarchiveSession']) {
      const original = registry[method].bind(registry)
      registry[method] = async (...args) => { calls.push([method, ...args]); await original(...args) }
    }
    ctx.provide('workspaceRegistry', registry)
    ctx.provide('storage', { backend: { get: () => ({ kv: { async open() { return {
      async loadAll() { return { global: null, tables: { trash: Object.fromEntries(medium) } } },
      async putRecord(table, id, value) { await hooks.put?.(id); medium.set(id, structuredClone(value)) },
      async deleteRecord(table, id) { await hooks.delete?.(id); medium.delete(id) },
      async deleteRecords(table, ids) { ids.forEach(id => medium.delete(id)) },
      async close() {},
    } } } }) } })
    ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'isolated' }))
    const trash = new TrashService(ctx)
    require('./legacy-purge-seam.cjs')(trash)
    const feed = new WorkspaceFeed(ctx)
    const model = new ClientWorkspaceModel({
      async archiveSession(request) {
        await registry.archiveSession(request.sessionId, request)
        return { ok: true, value: { archivedSessionIds: registry.archivedSessionIds } }
      },
      async unarchiveSession(request) {
        await registry.unarchiveSession(request.sessionId)
        return { ok: true, value: { archivedSessionIds: registry.archivedSessionIds } }
      },
    })
    model.replaceBaseline(feed.baseline())
    const accept = frame => {
      if (frame.type === 'archived') model.replaceArchived(frame.archivedSessionIds)
      else if (frame.type === 'pinned') model.replacePinned(frame.pinnedSessionIds)
      else if (frame.type === 'upsert') model.upsertView(frame.workspace)
      else if (frame.type === 'baseline') model.replaceBaseline(frame.value)
      else assert.fail(`unexpected frame ${frame.type}`)
    }
    const lifetime = new AbortController()
    let pump = Promise.resolve()
    if (mode !== 'none') {
      const follow = feed.follow(lifetime.signal)
      accept((await follow.next()).value)
      pump = (async () => {
        for await (const frame of follow) {
          if (mode === 'live') accept(frame)
          else queued.push(frame)
        }
      })()
    }
    const raw = Object.fromEntries(['trashSession', 'restoreSession', 'removeFromTrash', 'emptyTrash', 'listTrash']
      .map(method => [method, async (...args) => {
        delivery.push([method, ...args])
        const value = await trash[method](...args)
        await hooks.response?.(method, args)
        return { ok: true, value }
      }]))
    let activeReads = 0
    const reader = { async *follow(signal) {
      activeReads++
      delivery.push(['workspace-baseline'])
      const stream = feed.follow(signal)
      try {
        const frame = await stream.next()
        await hooks.baseline?.(frame.value, signal)
        yield frame.value
      } finally { await stream.return(); activeReads-- }
    } }
    const ui = new Context()
    new WorkspaceController(ui, model)
    ui.provide('remote.workspace', reader)
    ui.provide('remote.trash', raw)
    ui.provide('remote', { workspace: reader, async $mount() { return async () => {} } })
    // Deliberately real business writes: the old echo implementation would
    // rearchive a restored session here, rather than merely fixing a test set.
    ui.provide('uiWorkspace', {
      archiveSession: (id, options) => model.archiveSession(id, options),
      unarchiveSession: id => model.unarchiveSession(id),
    })
    let dictionaries
    ui.provide('locale', {
      register(ns, value) { dictionaries = value; return () => {} },
      bind() { return (key, values = {}) => Object.entries(values).reduce(
        (value, [key, replacement]) => value.replace(`{${key}}`, replacement), dictionaries.en[key]) },
      getSnapshot() { return { active: 'en' } },
    })
    const slots = new Map()
    ui.provide('slots', { inject(name, register) { register() }, register(options, component) {
      slots.set(options.name === 'main' ? 'trash-main' : options.id, { options, component })
    } })
    let definition
    vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load(value) { definition = value } } }, AbortController })
    const harness = require('./client-harness.cjs')((key, values = {}) => Object.entries(values).reduce(
      (value, [key, replacement]) => value.replace(`{${key}}`, replacement), dictionaries.en[key]))
    const fiber = ui.plugin(definition.factory(() => harness.React))
    await fiber
    const views = []
    const panel = () => {
      const view = harness.mount(slots.get('trash-main'), {
        useSessions: select => select({ byId: {} }), useWorkspaces: select => select(model.getSnapshot()),
      })
      views.push(view); view.render(); return view
    }
    const button = (view, label, inGroup = false) => {
      let tree = view.render()
      if (inGroup) tree = harness.find(tree, node => node.props.role === 'group')
      const found = harness.find(tree, node => node.type === 'button' && text(node) === label)
      assert.ok(found, `missing ${label} in ${text(tree)}`)
      return found
    }
    const move = (id, slot = 'trash-menu') => slots.get(slot).options.inject().moveToTrash(id)
    const settle = async () => { for (let turn = 0; turn < 6; turn++) await tick() }
    return { ctx, trash, registry, medium, model, hooks, calls, queued, accept, delivery, entities, feed,
      panel, button, move, settle, slots, harness,
      hasRow: (view, id) => Boolean(harness.find(view.render(), node => node.type === 'h2' && node.props.title === id)),
      visible(id) {
        return visibleSessionIds({ ids: [id], byId: { [id]: { id, blank: false, retainedBy: {} } } },
          model.getSnapshot().archivedSessionIds, 'default').includes(id)
      },
      async dispose() {
        releases.forEach(release => release()); releases.clear()
        views.forEach(view => view.unmount())
        await fiber.dispose(); await ui.fiber.dispose()
        assert.equal(activeReads, 0, 'one-shot refresh streams must all close')
        assert.equal(model.listeners.size, 0, 'Workspace model sync subscription must be disposed')
        lifetime.abort(); await pump
        await ctx.fiber.dispose(); await workspaceDomain.close()
      },
    }
  }

  async function test(name, run, mode) {
    const f = await fixture(mode)
    let timer
    try {
      await Promise.race([run(f), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 5000)
      })])
      emit('review2fix-regression', { name, result: 'PASS' })
    } finally { clearTimeout(timer); await f.dispose() }
  }

  await test('B1 native unarchive before marker put rejects without creating a new marker', async f => {
    const gate = pause()
    const archive = f.registry.archiveSession.bind(f.registry)
    f.registry.archiveSession = async (...args) => { await archive(...args); await gate.wait() }
    let puts = 0
    f.hooks.put = () => { puts++ }
    const moving = assert.rejects(f.trash.trashSession('before-put'), /was unarchived/)
    await gate.arrived
    await f.registry.unarchiveSession('before-put')
    gate.release(); await moving
    assert.equal(puts, 0)
    assert.equal(f.medium.size, 0)
  })

  await test('B1 native unarchive during durable marker put is detected and compensated before rejection', async f => {
    const gate = pause()
    f.hooks.put = () => gate.wait()
    const moving = assert.rejects(f.trash.trashSession('native-race'), /was unarchived/)
    await gate.arrived
    await f.registry.unarchiveSession('native-race')
    gate.release(); await moving
    assert.equal(f.registry.archivedSessionIds.includes('native-race'), false)
    assert.equal(f.medium.has('native-race'), false, 'must be cleaned without listTrash')
  })

  await test('B1 marker compensation keeps the session lock until a queued retrash can safely proceed', async f => {
    const put = pause(), cleanup = pause()
    f.hooks.put = () => put.wait()
    f.hooks.delete = () => cleanup.wait()
    const moving = assert.rejects(f.trash.trashSession('locked'), /was unarchived/)
    await put.arrived
    await f.registry.unarchiveSession('locked')
    put.release(); await cleanup.arrived
    delete f.hooks.put
    const before = f.calls.length
    const retrash = f.trash.trashSession('locked')
    await tick()
    assert.equal(f.calls.length, before, 'retrash cannot overtake compensation')
    cleanup.release(); await moving; await retrash
    assert.equal(f.medium.has('locked'), true)
    assert.equal(f.registry.archivedSessionIds.includes('locked'), true)
  })

  await test('B1 compensation failure is explicit; later list reconciles a native stale marker', async f => {
    const gate = pause()
    f.hooks.put = () => gate.wait()
    f.hooks.delete = () => { throw new Error('delete compensation failed') }
    const moving = assert.rejects(f.trash.trashSession('failed-cleanup'), error => {
      assert.equal(error.name, 'AggregateError')
      assert.match(error.errors[0].message, /was unarchived/)
      assert.match(error.errors[1].message, /delete compensation/)
      return true
    })
    await gate.arrived; await f.registry.unarchiveSession('failed-cleanup')
    gate.release(); await moving
    assert.equal(f.medium.has('failed-cleanup'), true)
    delete f.hooks.delete
    assert.deepEqual(await f.trash.listTrash(), [])
    assert.equal(f.medium.size, 0)
  })

  for (const native of [false, true]) {
    await test(`M1 delayed trash response after ${native ? 'native unarchive' : 'panel restore'} never rearchives`, async f => {
      await f.move('a')
      const view = f.panel(); await f.settle()
      const gate = pause()
      f.hooks.response = method => method === 'trashSession' ? gate.wait() : undefined
      const late = f.move('a', 'trash-action')
      await gate.arrived
      if (native) {
        await f.model.unarchiveSession('a') // native unary really writes Registry
      } else {
        f.button(view, 'Restore').props.onClick(); await f.settle()
      }
      assert.equal(f.registry.archivedSessionIds.includes('a'), false)
      gate.release(); await late; await f.settle()
      assert.equal(f.registry.archivedSessionIds.includes('a'), false)
      if (native) {
        assert.equal(f.hasRow(view, 'a'), false)
        await f.trash.listTrash() // native unarchive's stale marker is lazily reconciled
      }
      assert.equal(f.medium.has('a'), false)
      assert.equal(f.visible('a'), true)
      assert.equal(f.calls.filter(([method]) => method === 'archiveSession').length, 2,
        'exactly the two TrashService calls, no Client echo business write')
    })
  }

  for (const action of ['Delete forever', 'Empty trash']) {
    for (const slot of ['trash-menu', 'trash-action']) {
      await test(`M2 ${slot} delayed retrash response after ${action} cannot revive either panel`, async f => {
        await f.move('a')
        const first = f.panel(), second = f.panel(); await f.settle()
        const gate = pause()
        f.hooks.response = method => method === 'trashSession' ? gate.wait() : undefined
        const late = f.move('a', slot)
        await gate.arrived
        f.button(second, action).props.onClick()
        f.button(second, action, true).props.onClick(); await f.settle()
        assert.equal(f.medium.has('a'), false)
        assert.equal(f.hasRow(first, 'a'), false)
        const reads = f.delivery.filter(([method]) => method === 'listTrash').length
        gate.release(); await late; await f.settle()
        assert.ok(f.delivery.filter(([method]) => method === 'listTrash').length > reads,
          'stale write response must trigger an authoritative reload')
        assert.equal(f.hasRow(first, 'a'), false)
        assert.equal(f.hasRow(second, 'a'), false)
        assert.equal(f.medium.has('a'), false)
        assert.equal(f.registry.archivedSessionIds.includes('a'), false)
      })
    }
  }

  await test('M2 delayed empty response must not clear a newer cross-session trash', async f => {
    await f.move('a')
    const view = f.panel(); await f.settle()
    const gate = pause()
    f.hooks.response = method => method === 'emptyTrash' ? gate.wait() : undefined
    f.button(view, 'Empty trash').props.onClick(); f.button(view, 'Empty trash', true).props.onClick()
    await gate.arrived
    await f.move('b', 'trash-action')
    gate.release(); await f.settle()
    assert.equal(f.hasRow(view, 'a'), false)
    assert.equal(f.hasRow(view, 'b'), true)
    assert.equal(f.medium.has('b'), true)
  })

  for (const mode of ['live', 'none', 'late']) {
    await test(`M3 restore updates actual Workspace model with ${mode} follow`, async f => {
      await f.move('restore-a')
      assert.equal(f.visible('restore-a'), false)
      const view = f.panel(); await f.settle()
      f.button(view, 'Restore').props.onClick(); await f.settle()
      assert.equal(f.medium.has('restore-a'), false)
      assert.equal(f.visible('restore-a'), true)
      if (mode === 'late') {
        const old = f.queued.find(frame => frame.type === 'archived' && frame.archivedSessionIds.includes('restore-a'))
        assert.ok(old, 'must capture a real old WorkspaceFeed frame')
        f.accept(old); await f.settle()
        assert.equal(f.visible('restore-a'), true, 'late old follow must be repaired by another read')
      }
      assert.equal(f.calls.filter(([method]) => method === 'unarchiveSession').length, 1)
      assert.equal(f.registry.archivedSessionIds.includes('restore-a'), false)
    }, mode)
  }

  await test('M1/M3 stale opening baseline racing restore is discarded and reread', async f => {
    await f.move('a')
    const view = f.panel(); await f.settle()
    const gate = pause()
    let once = true
    f.hooks.baseline = async () => { if (once) { once = false; await gate.wait() } }
    f.button(view, 'Refresh').props.onClick(); await gate.arrived
    const restoring = f.slots.get('trash-main').options.inject().trash.restoreSession('a')
    await tick()
    gate.release(); await restoring; await f.settle()
    assert.equal(f.visible('a'), true)
    assert.equal(f.registry.archivedSessionIds.includes('a'), false)
  })

  await test('consistency purge detaches only owning installed WorkspaceEntity and persists membership cleanup', async f => {
    await f.move('owned-session')
    const owner = f.entities.get('work-a'), unrelated = f.entities.get('work-b')
    const detach = owner.detachSession.bind(owner)
    let detaches = 0
    owner.detachSession = async id => { detaches++; await detach(id) }
    unrelated.detachSession = () => assert.fail('nonmember WorkspaceEntity must not be detached')
    assert.equal(await f.trash.removeFromTrash('owned-session'), true)
    assert.equal(detaches, 1)
    assert.deepEqual(owner.sessionIds, [])
    assert.deepEqual(f.feed.baseline().items.find(item => item.workspaceId === 'work-a').sessionIds, [])
    assert.equal(f.medium.size, 0)
    assert.equal(f.registry.archivedSessionIds.includes('owned-session'), false)
  })

  await test('m1 normal move derives workspace title, rename, moved ownership and detached fallback from model', async f => {
    await f.move('owned-session')
    assert.equal(f.medium.get('owned-session').workspaceId, undefined, 'test must not preseed marker metadata')
    const view = f.panel(); await f.settle()
    assert.match(text(view.render()), /Workspace: Workspace A/)
    await f.entities.get('work-a').setTitle('Renamed workspace')
    f.model.replaceBaseline(f.feed.baseline()); await f.settle()
    assert.match(text(view.render()), /Workspace: Renamed workspace/)
    const items = f.model.getSnapshot().items.map(item => ({ ...item,
      sessionIds: item.workspaceId === 'work-b' ? ['owned-session'] : [],
    }))
    // Workspace snapshots can change ownership independently of trash markers.
    f.model.replaceBaseline({ ...f.feed.baseline(), items }); await f.settle()
    assert.match(text(view.render()), /Workspace: Workspace B/)
    f.model.replaceBaseline({ ...f.feed.baseline(), items: [] }); await f.settle()
    assert.match(text(view.render()), /Workspace: No workspace/)
  })
}
