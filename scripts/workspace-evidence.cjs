// Read-only installed-source probes. No profile, real storage or sessions.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

module.exports = async function workspaceEvidence(installed, emit) {
  const cache = new Map()
  // Electron reads selected sources inside ASAR; transpilation stays in memory.
  function source(pkg, relative) {
    return load(path.join(path.dirname(installed.resolve(`@deepseek-ai/${pkg}/package.json`)), relative))
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText
    vm.runInThisContext(`(function(require, module, exports) {${code}\n})`, { filename: file })(
      id => {
        // This browser-only utility is absent from the CLI resolver. Keep
        // notification delivery as a seam; archive projection stays original.
        if (id === '@deepseek-ai/dsh-client-store') return {
          notifySubscribers(listeners) { for (const listener of listeners) listener() },
        }
        return id.startsWith('.') ? load(path.resolve(path.dirname(file), id)) : installed(id)
      },
      module, module.exports)
    return module.exports
  }
  const { WorkspaceRegistry, workspaceDomainSpec } = installed('@deepseek-ai/dsh-workspace')
  const { Context } = installed('@deepseek-ai/cordis')
  const { DomainImpl } = source('dsh-storage-domain', 'src/domain.ts')
  const { WorkspaceFeed } = source('dsh-api-workspace-controller', 'src/feed.ts')
  const { WorkspaceController } = source('dsh-api-workspace-controller', 'src/client/service.ts')
  const { ClientWorkspaceModel } = source('dsh-api-workspace-controller', 'src/client/model.ts')
  const { visibleSessionIds } = source('dsh-client-ui-workspace', 'src/client/tree.ts')
  const ctx = new Context()
  const writes = []
  const changes = []
  const initial = { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: ['probe'] }
  const domain = new DomainImpl(ctx, workspaceDomainSpec, {
    async setGlobal(value) { writes.push(value) }, async close() {},
  }, new Map([['workspaces', new Map()]]), initial, () => {})
  // Keep the actual installed archive/setState/requireState/queue methods.
  // Only session existence/activity and the storage backend are isolated seams.
  const registry = Object.create(WorkspaceRegistry.prototype)
  Object.defineProperty(registry, 'ctx', { value: ctx })
  Object.assign(registry, { state: initial, global: domain.global,
    operationTail: Promise.resolve(), sessionKnown: async () => true,
    stopSessionActivity: async () => {},
  })
  ctx.provide('workspaceRegistry', registry)
  ctx.on('domain/changed', change => { changes.push(change) })
  const feed = new WorkspaceFeed(ctx)
  const abort = new AbortController()
  const follow = feed.follow(abort.signal)
  try {
    const baseline = (await follow.next()).value
    const nextFrame = follow.next()
    await registry.archiveSession('probe', { stopActivity: true })
    assert.equal(writes.length, 1)
    assert.equal(changes[0].domain, 'workspace')
    assert.equal(changes[0].table, '')
    assert.equal(changes[0].operation, 'put')
    let deadline
    const frame = (await Promise.race([nextFrame, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Workspace archived frame was not emitted')), 3000)
    })]).finally(() => clearTimeout(deadline))).value
    assert.equal(frame.type, 'archived')
    assert.deepEqual(frame.archivedSessionIds, ['probe'])
    await registry.archiveSession('probe', { stopActivity: true })
    assert.equal(writes.length, 1, 'repeat archive is a durable no-op')
    const model = new ClientWorkspaceModel({ async archiveSession({ sessionId }) {
      return { ok: true, value: { archivedSessionIds: [sessionId] } }
    } })
    model.replaceBaseline(baseline.value)
    model.replaceArchived(frame.archivedSessionIds)
    const list = { ids: ['probe'], byId: { probe: { id: 'probe', blank: false, retainedBy: {} } } }
    assert.deepEqual(visibleSessionIds(list, model.getSnapshot().archivedSessionIds, 'default'), [])
    assert.deepEqual(visibleSessionIds(list, model.getSnapshot().archivedSessionIds, 'show'), ['probe'])
    model.replaceBaseline(baseline.value) // Simulate an absent/delayed follow echo.
    assert.deepEqual(visibleSessionIds(list, model.getSnapshot().archivedSessionIds, 'default'), ['probe'])
    await model.archiveSession('probe', { stopActivity: true })
    assert.deepEqual(visibleSessionIds(list, model.getSnapshot().archivedSessionIds, 'default'), [])
    emit('phase3fix2-workspace-evidence', { globalWrites: writes.length,
      event: { domain: changes[0].domain, table: changes[0].table, operation: changes[0].operation },
      frame: frame.type, followHidesRow: true, unaryEchoHidesRowWithoutFollow: true,
      repeatArchiveWrites: 0, showArchivedPreserved: true })

    const nextUnarchive = (async () => {
      for (;;) {
        const next = await follow.next()
        if (next.done || next.value.type === 'archived') return next
        assert.equal(next.value.type, 'pinned', 'archive may first enqueue the pin-removal frame')
      }
    })()
    await registry.unarchiveSession('probe')
    const unarchiveFrame = (await Promise.race([nextUnarchive, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Workspace unarchive frame was not emitted')), 3000)
    })]).finally(() => clearTimeout(deadline))).value
    assert.equal(unarchiveFrame.type, 'archived')
    assert.deepEqual(unarchiveFrame.archivedSessionIds, [])
    let notifications = 0
    const unsubscribe = model.subscribe(() => { notifications++ })
    model.replaceArchived(unarchiveFrame.archivedSessionIds)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(notifications > 0, 'native unarchive feed must invalidate Workspace subscribers')
    assert.deepEqual(model.getSnapshot().archivedSessionIds, [])
    unsubscribe()
    emit('unarchive-workspace-feed', { frame: unarchiveFrame.type, archiveSet: [], subscribersNotified: true })

    // A Domain can be owned by a different Context than the registry service.
    // Its event is not a reliable universal signal for a Trash sibling plugin.
    const storageCtx = new Context()
    const isolatedEvents = []
    const registryEvents = []
    storageCtx.on('domain/changed', change => { isolatedEvents.push(change) })
    const stopRegistryEvents = ctx.on('domain/changed', change => { registryEvents.push(change) })
    const isolatedDomain = new DomainImpl(storageCtx, workspaceDomainSpec, {
      async setGlobal() {}, async close() {},
    }, new Map([['workspaces', new Map()]]), initial, () => {})
    try {
      const isolatedRegistry = Object.create(WorkspaceRegistry.prototype)
      Object.defineProperty(isolatedRegistry, 'ctx', { value: ctx })
      Object.assign(isolatedRegistry, { state: initial, global: isolatedDomain.global,
        operationTail: Promise.resolve(), sessionKnown: async () => true, stopSessionActivity: async () => {},
      })
      await isolatedRegistry.archiveSession('separate-context', { stopActivity: true })
      await isolatedRegistry.unarchiveSession('separate-context')
      assert.deepEqual(isolatedRegistry.archivedSessionIds, [])
      assert.equal(isolatedEvents.length, 2)
      assert.equal(registryEvents.length, 0)
      emit('unarchive-isolated-contexts', { storageDomainEvents: 2, registryContextEvents: 0,
        hostReconciliationRequiresNoEvent: true })
    } finally {
      stopRegistryEvents()
      await isolatedDomain.close()
      await storageCtx.fiber.dispose()
    }
    return { ClientWorkspaceModel, visibleSessionIds, DomainImpl, WorkspaceFeed, WorkspaceController, source }
  } finally {
    abort.abort()
    await follow.return()
    await domain.close()
    await ctx.fiber.dispose()
  }
}
