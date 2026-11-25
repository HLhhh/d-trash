// Run only with the installed Electron runtime. All writes stay in a temp tree.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { tmpdir } = require('node:os')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')

assert.ok(process.versions.electron, 'Use ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE"')
assert.ok(process.env.DSH_INSTALL_DIR, 'DSH_INSTALL_DIR is required')
const installed = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
const { Context } = installed('@deepseek-ai/cordis')
const { PluginPackages, mountRootInclude } = installed('@deepseek-ai/dsh-app-boot')
const Loader = installed('@deepseek-ai/cordis-plugin-loader').default
const typertLoader = installed('@deepseek-ai/dsh-typert-loader')
const ClientModules = installed('@deepseek-ai/dsh-client-modules').default
const { TypertRegistry } = installed('@deepseek-ai/dsh-typert-registry')
const gateway = installed('@deepseek-ai/dsh-api-gateway/client')
const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'trash-discovery-')))
const contexts = []
const url = directory => pathToFileURL(directory).href + '/'
const emit = (check, data) => console.log(JSON.stringify({ check, ...data }))
const protectedFiles = fs.readdirSync(root)
  .filter(file => /^(?:CODEX_.*\.md|PLAN\.md|AGENTS\.md)$/.test(file))
  .map(file => path.join(root, file))
if (process.env.DSH_PROFILE_DIR) {
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
    protectedFiles.push(path.join(process.env.DSH_PROFILE_DIR, file))
  }
}
const hashes = () => protectedFiles.map(file => [file,
  fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null])
const before = hashes()
function context() { const ctx = new Context(); contexts.push(ctx); return ctx }
function profile(name, linked = true) {
  const directory = path.join(temporary, 'profiles', name)
  fs.mkdirSync(path.dirname(path.join(directory, 'node_modules', manifest.name)), { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true,
    dependencies: { [manifest.name]: `link:${root}` } }))
  fs.writeFileSync(path.join(directory, 'cordis.yml'), '[]\n')
  if (linked) fs.symlinkSync(root, path.join(directory, 'node_modules', manifest.name), process.platform === 'win32' ? 'junction' : 'dir')
  return directory
}
function resolution(directory) {
  return { profilesDir: path.dirname(directory), profileDir: directory,
    localPackageNames: [manifest.name], linkedRoots: [{ name: manifest.name, realPath: root }],
    entries: [] }
}
function harness(baseUrl, packages) {
  const row = { options: { name: manifest.name }, fiber: {}, disabled: false }
  const registrations = []
  const events = new Map()
  const errors = []
  let lookups = 0
  return { registrations, row, errors, events,
    get lookups() { return lookups },
    ctx: { baseUrl, loader: { entries: () => [row] }, effect() {},
      on(name, callback) { events.set(name, callback) },
      get(name) { assert.equal(name, 'pluginPackages'); return {
        packageOf(...args) { lookups++; return packages.packageOf(...args) },
      } },
      typert: { register(contribution) { registrations.push(contribution); return async () => {} } },
      logger: { error(error) { errors.push(error) } },
    },
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  emit('runtime', { node: process.versions.node, electron: process.versions.electron,
    dsh: installed('@deepseek-ai/dsh/package.json').version })
  await require('./platform-evidence.cjs')(installed, emit)
  const evidence = await require('./workspace-evidence.cjs')(installed, emit)
  const { ClientWorkspaceModel, visibleSessionIds, WorkspaceController } = evidence
  // Load an existing version-1 trash.json with the installed JSON backend.
  // This entire home is synthetic; no real marker file or session is touched.
  const { JsonStorageBackend } = installed('@deepseek-ai/dsh-storage-json')
  const { DomainFacility } = installed('@deepseek-ai/dsh-storage-domain')
  const TrashService = (await import('../dist/index.js')).default
  const storageRoot = path.join(temporary, 'legacy-home', 'storages')
  fs.mkdirSync(storageRoot, { recursive: true })
  const legacyFile = path.join(storageRoot, 'trash.json')
  const legacy = { trashedAt: 1, workspaceId: 'legacy-workspace', titleSnapshot: 'Saved marker' }
  const pending = { trashedAt: 2, purge: {
    source: path.join(temporary, 'legacy-home', 'sessions', 'cwd', 'pending'),
    target: path.join(temporary, 'legacy-home', 'sessions.trash-purge-staging', 'pending-test'),
    dev: '1', ino: '2', logsDeleted: false, deleting: false,
  } }
  fs.writeFileSync(legacyFile, JSON.stringify({ unit: { name: 'trash', version: 1 },
    global: null, tables: { trash: { legacy, pending } } }))
  const original = fs.readFileSync(legacyFile, 'utf8')
  for (let round = 0; round < 2; round++) {
    const ctx = context()
    const backend = new JsonStorageBackend(storageRoot)
    const archived = new Set(['legacy'])
    ctx.provide('storage', { backend: { get: () => backend } })
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.provide('storageDomain', facility)
    ctx.provide('workspaceRegistry', { list: () => [],
      get archivedSessionIds() { return [...archived] },
      async unarchiveSession(id) { archived.delete(id) },
    })
    const trash = new TrashService(ctx)
    try {
      assert.deepEqual(await trash.listTrash(), [
        ['legacy', legacy], ['pending', { trashedAt: 2, purgePending: true }],
      ])
      assert.ok(facility.get('trash'))
      assert.equal(facility.get(manifest.name), undefined)
      assert.equal(fs.readFileSync(legacyFile, 'utf8'), original, 'reading must preserve legacy data and purge receipts')
      if (round === 1) {
        await trash.restoreSession('legacy')
        const saved = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
        assert.deepEqual(saved.unit, { name: 'trash', version: 1 })
        assert.deepEqual(saved.tables.trash, { pending })
      }
      assert.deepEqual(fs.readdirSync(storageRoot), ['trash.json'])
    } finally {
      await ctx.fiber.dispose()
      await backend.close()
    }
  }
  emit('package-rename-storage-compatibility', { package: manifest.name, domain: 'trash',
    version: 1, file: 'trash.json', reopened: true, restored: true, purgeReceiptPreserved: true })
  for (const name of ['dsh-app-boot', 'dsh-typert-loader', 'cordis']) {
    emit('installed-package', { name, manifest: installed.resolve(`@deepseek-ai/${name}/package.json`) })
  }
  const directory = profile('linked')
  const packages = new PluginPackages(context(), { resolution: resolution(directory) })
  for (const [anchor, baseUrl] of [['profile', url(directory)], ['linked-root', url(root)],
    ['installation', url(process.env.DSH_INSTALL_DIR)]]) {
    const found = packages.packageOf(manifest.name, baseUrl)
    let requireResolve
    try { requireResolve = createRequire(baseUrl).resolve(`${manifest.name}/package.json`) }
    catch (error) { requireResolve = error.code }
    const searchHits = createRequire(baseUrl).resolve.paths(manifest.name)
      .filter(search => fs.existsSync(path.join(search, `${manifest.name}/package.json`)))
    emit('packageOf', { anchor, result: found?.dir ?? null, requireResolve, searchHits })
    assert.equal(Boolean(found), anchor === 'profile')
  }
  // Verify the installed resolver, not a guessed reproduction of resolveArtifact.
  const fresh = harness(url(directory), packages)
  await typertLoader.apply(fresh.ctx, { packages: [] })
  assert.equal(fresh.registrations.length, 1)
  const contribution = fresh.registrations[0]
  assert.equal(contribution.package, manifest.name)
  assert.equal(contribution.invocations.length, 5)
  emit('resolveArtifact', { artifact: path.join(root, 'dist/typert.host.js'),
    registrations: fresh.registrations.length, services: contribution.model.services.map(s => s.key),
    invocations: contribution.invocations.length })

  // main and the patch export are compatibility additions, not a discovery gate.
  const variantDir = profile('manifest-before')
  fs.unlinkSync(path.join(variantDir, 'node_modules', manifest.name))
  const variant = path.join(variantDir, 'node_modules', manifest.name)
  fs.mkdirSync(variant)
  const oldManifest = structuredClone(manifest)
  delete oldManifest.main
  delete oldManifest.exports['./cordis.patch.yml']
  fs.writeFileSync(path.join(variant, 'package.json'), JSON.stringify(oldManifest))
  fs.symlinkSync(path.join(root, 'dist'), path.join(variant, 'dist'), process.platform === 'win32' ? 'junction' : 'dir')
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(variant, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const variantPackages = new PluginPackages(context(), { resolution: resolution(variantDir) })
  const variantHarness = harness(url(variantDir), variantPackages)
  await typertLoader.apply(variantHarness.ctx, { packages: [] })
  assert.equal(variantHarness.registrations.length, 1)
  emit('without-main-and-patch-export', { registrations: 1 })

  // A missing link at first scan is silently remembered even after lookup recovers.
  const lateDir = profile('late-link', false)
  const latePackages = new PluginPackages(context(), { resolution: resolution(lateDir) })
  const stale = harness(url(lateDir), latePackages)
  await typertLoader.apply(stale.ctx, { packages: [] })
  assert.equal(stale.registrations.length, 0)
  fs.symlinkSync(root, path.join(lateDir, 'node_modules', manifest.name), process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(latePackages.packageOf(manifest.name, url(lateDir)))
  stale.events.get('internal/plugin')({ entry: stale.row })
  await tick()
  assert.equal(stale.registrations.length, 0)
  assert.equal(stale.lookups, 1)
  const restarted = harness(url(lateDir), latePackages)
  await typertLoader.apply(restarted.ctx, { packages: [] })
  assert.equal(restarted.registrations.length, 1)
  emit('negative-cache', { recoveredPackageOf: true, registrationsAfterEvent: 0,
    lookupsAfterEvent: stale.lookups, registrationsAfterNewLoader: 1 })

  // PluginPackages also retains the first parsed manifest until replace/restart.
  fs.writeFileSync(path.join(variant, 'package.json'), JSON.stringify(manifest))
  assert.equal(variantPackages.packageOf(manifest.name, url(variantDir)).manifest.main, undefined)
  variantPackages.replace(resolution(variantDir))
  assert.equal(variantPackages.packageOf(manifest.name, url(variantDir)).manifest.main, manifest.main)
  emit('manifest-cache', { diskEditAloneRefreshes: false, replaceRefreshes: true })

  // Real Loader + root Include, with only in-memory application services.
  const host = context()
  host.baseUrl = url(directory)
  await host.plugin(Loader)
  host.provide('typert', { register() { return async () => {} } })
  host.provide('storageDomain', {})
  host.provide('workspaceRegistry', {})
  host.provide('sessionPersistence', {})
  await mountRootInclude(host, path.join(directory, 'cordis.yml'),
    [{ insert: [{ id: 'trash', name: manifest.name }] }], url(directory))
  await host.loader.await()
  const rows = [...host.loader.entries()].filter(row => row.options.name === manifest.name)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].fiber)
  assert.equal(rows[0].disabled, false)
  assert.equal(typeof host.get('trash')?.removeFromTrash, 'function', 'new Host dependency must be satisfied')
  const clientModules = new ClientModules(host)
  assert.ok(clientModules.graph().entries.some(entry => entry.id === manifest.name))
  assert.equal(clientModules.clientPath(manifest.name), path.join(root, 'dist/client.js'))
  emit('clientModules', { entryName: rows[0].options.name, qualifies: true,
    baseUrl: rows[0].parent.tree.ctx.baseUrl, clientPath: clientModules.clientPath(manifest.name) })

  // The plugin starts with no trash namespace; its own assembly must supply it.
  const browser = context()
  const nativeArchiveCalls = []
  const hostArchived = new Set()
  const workspaceModel = new ClientWorkspaceModel({ async archiveSession(request) {
    nativeArchiveCalls.push(request)
    assert.fail('Trash must not issue a second Workspace business write')
  } })
  new WorkspaceController(browser, workspaceModel)
  browser.provide('remote.workspace', { async *follow(signal) {
    signal.throwIfAborted()
    yield { type: 'baseline', value: { archivedSessionIds: [...hostArchived], pinnedSessionIds: [] } }
  } })
  new TypertRegistry(browser)
  let wire
  browser.provide('connection', { interactions: 'none', rpc: {
    open() { throw new Error('No stream should be opened') },
    async call(route, endpoint, payload) {
      wire = { route, endpoint, payload }
      if (endpoint === 'trash/trashSession') hostArchived.add(payload.args.sessionId)
      if (endpoint === 'trash/restoreSession') hostArchived.delete(payload.args.sessionId)
      const value = endpoint === 'trash/listTrash' ? []
        : endpoint === 'trash/removeFromTrash' ? true : endpoint === 'trash/emptyTrash' ? 2 : undefined
      return { ok: true, value }
    },
  } })
  gateway.apply(browser)
  assert.equal(browser.get('remote.trash'), undefined)
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { definition = value } } }, AbortController,
  })
  const plugin = definition.factory(name => { assert.equal(name, 'react'); return {} })
  const slots = new Map()
  browser.provide('slots', { inject(name, register) { register() },
    register(options) { slots.set(options.name === 'main' ? 'trash-main' : options.id, options) } })
  browser.provide('locale', { register() { return () => {} }, bind() { return key => key },
    getSnapshot() { return { active: 'en' } } })
  // A root Context bypasses inject checks. Reproduce from an actual plugin fiber.
  const remoteContribution = createRequire(path.join(root, 'package.json'))(`${manifest.name}/remote`).default
  let unsafeMove
  let safeMove
  const probe = browser.plugin({ inject: ['slots', 'locale', 'remote'],
    async apply(ctx) {
      const dispose = await ctx.remote.$mount(remoteContribution)
      unsafeMove = () => ctx.remote.trash.trashSession('unsafe-session')
      const trash = ctx.get('remote.trash')
      assert.ok(trash, 'ctx.get must resolve the mounted namespace inside a plugin')
      safeMove = () => trash.trashSession('get-session')
      return dispose
    },
  })
  await probe
  assert.throws(unsafeMove, { message: 'cannot get property "remote.trash" without inject' })
  assert.equal(wire, undefined, 'inject check must fail before the RPC transport')
  emit('client-inject-reproduction', { error: 'cannot get property "remote.trash" without inject', rpcCalled: false })
  assert.equal((await safeMove()).ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(wire.payload)), { args: { sessionId: 'get-session' } })
  emit('client-ctx-get-probe', { ok: true, wire })
  await probe.dispose()
  assert.equal(browser.get('remote.trash'), undefined)
  wire = undefined
  let oldApplyRan = false
  const blocked = browser.plugin({ inject: ['slots', 'locale', 'remote.trash'],
    apply() { oldApplyRan = true } })
  await tick()
  assert.equal(oldApplyRan, false)
  assert.equal(slots.size, 0)
  await blocked.dispose()
  emit('client-pre-fix-dependency-gate', { remoteTrashPresent: false, applyRan: oldApplyRan, slots: slots.size })
  const fiber = browser.plugin(plugin)
  await fiber
  assert.ok(browser.get('remote.trash'))
  assert.deepEqual([...slots.keys()].sort(), ['trash', 'trash-action', 'trash-main', 'trash-menu'])
  assert.equal(slots.get('trash').name, 'sidebar.panellist')
  assert.equal(slots.get('trash-main').name, 'main')
  assert.equal(slots.get('trash').id, slots.get('trash-main').key)
  // Exercise the closure registered by the plugin, never the unchecked root Context.
  for (const id of ['trash-action', 'trash-menu']) await slots.get(id).inject().moveToTrash('isolated-session')
  assert.deepEqual(JSON.parse(JSON.stringify(wire)), {
    route: '/api', endpoint: 'trash/trashSession', payload: { args: { sessionId: 'isolated-session' } },
  })
  const moveWire = wire
  assert.deepEqual(nativeArchiveCalls, [])
  assert.deepEqual(visibleSessionIds({ ids: ['isolated-session'], byId: {
    'isolated-session': { id: 'isolated-session', blank: false, retainedBy: {} },
  } }, workspaceModel.getSnapshot().archivedSessionIds, 'default'), [])
  emit('review2fix-slot-read-only-workspace-sync', { calls: nativeArchiveCalls, snapshotHidesRow: true })
  const panelRemote = slots.get('trash-main').inject().trash
  const panelWire = []
  for (const [method, args, expected] of [
    ['listTrash', [], []], ['restoreSession', ['restore-session'], undefined],
    ['removeFromTrash', ['remove-session'], true], ['emptyTrash', [], 2],
  ]) {
    const result = await panelRemote[method](...args)
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, expected)
    assert.deepEqual(JSON.parse(JSON.stringify(wire)), { route: '/api', endpoint: `trash/${method}`,
      payload: { args: args.length ? { sessionId: args[0] } : {} } })
    panelWire.push(wire)
  }
  emit('phase3-panel-Gateway-RPC', { sidebarId: slots.get('trash').id,
    mainKey: slots.get('trash-main').key, wire: panelWire })
  await fiber.dispose()
  assert.equal(browser.get('remote.trash'), undefined)
  emit('client-Gateway-integration', { namespaceBefore: false, namespaceAfterMount: true,
    slots: [...slots.keys()].sort(), wire: moveWire, namespaceAfterDispose: false })
  await require('./review2fix-regressions.cjs')(installed, emit, evidence)
  await require('./reappear-evidence.cjs')(installed, emit)
  await import('./platform-regressions.mjs')
  await import('./system-trash-regressions.mjs')
  await import('./phase4-regressions.mjs')
  await import('./ghost-regressions.mjs')
  await import('./operation-log-regressions.mjs')
  await import('./deferred-regressions.mjs')
  await import('./reappear-regressions.mjs')
  assert.deepEqual(hashes(), before, 'Protected documents and real profile files must remain unchanged')
  console.log('PASS: installed resolver, Typert scan/cache, real Loader/ClientModules, Gateway inject reproduction and slot RPC lifecycle; profile unchanged')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  fs.rmSync(temporary, { recursive: true, force: true })
})

