// A separate Electron process: no synthetic resolver or module cache precedes boot.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire, syncBuiltinESMExports } = require('node:module')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { createHash } = require('node:crypto')

assert.ok(process.versions.electron, 'Use the installed Electron runtime')
assert.ok(process.env.DSH_INSTALL_DIR, 'DSH_INSTALL_DIR is required')
assert.ok(process.env.DSH_PROFILE_DIR, 'DSH_PROFILE_DIR is required for read-only profile boot')
const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const directory = fs.realpathSync(process.env.DSH_PROFILE_DIR)
const temporary = fs.realpathSync(fs.mkdtempSync('/private/tmp/trash-profile-boot-'))
const protectedFiles = fs.readdirSync(root)
  .filter(file => /^(?:CODEX_.*\.md|PLAN\.md|AGENTS\.md)$/.test(file))
  .map(file => path.join(root, file))
for (const file of fs.readdirSync(directory)) {
  const full = path.join(directory, file)
  if (fs.lstatSync(full).isFile()) protectedFiles.push(full)
}
const hashes = () => protectedFiles.map(file => [file,
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
const before = hashes()

// Deny mutations before loading app-boot (which can normalize profile manifests).
// In particular a future version must not silently create a .cordis helper there.
const blocked = []
const restorers = []
function replace(object, key, value) {
  const previous = object[key]
  object[key] = value(previous)
  restorers.push(() => { object[key] = previous })
}
function writable(value) {
  const target = value instanceof URL ? fileURLToPath(value) : String(value)
  let ancestor = path.resolve(target)
  const tail = []
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const canonical = path.join(fs.realpathSync(ancestor), ...tail)
  if (canonical === temporary || canonical.startsWith(temporary + path.sep)) return
  blocked.push({ operation: 'write', path: target })
  throw new Error(`Read-only profile boot blocked mutation outside fixture: ${target}`)
}
for (const name of ['appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'link', 'mkdir',
  'mkdtemp', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile']) {
  // Source is read-only for copy, link and symlink; rename mutates both paths.
  const indexes = ['copyFile', 'cp', 'link', 'symlink'].includes(name) ? [1]
    : name === 'rename' ? [0, 1] : [0]
  for (const [object, key] of [[fs, name], [fs, name + 'Sync'], [fs.promises, name]]) {
    if (typeof object[key] !== 'function') continue
    replace(object, key, original => function (...args) {
      indexes.forEach(index => writable(args[index]))
      return original.apply(this, args)
    })
  }
}
for (const [object, key] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) {
  replace(object, key, original => function (file, flags, ...args) {
    const writes = typeof flags === 'number'
      ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
        | fs.constants.O_TRUNC | fs.constants.O_APPEND)
      : /[wa+]/.test(flags)
    if (writes) writable(file)
    return original.call(this, file, flags, ...args)
  })
}
replace(require('node:net').Server.prototype, 'listen', () => function () {
  throw new Error('Read-only profile boot must not start a server')
})
syncBuiltinESMExports()

const installed = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
const emit = (check, data) => console.log(JSON.stringify({ check, ...data }))
const url = dir => pathToFileURL(dir).href + '/'
const endpoint = 'trash/trashSession'
const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
const tick = () => new Promise(resolve => setImmediate(resolve))
let ctx
async function main() {
  const boot = installed('@deepseek-ai/dsh-app-boot')
  const { Context, FiberState } = installed('@deepseek-ai/cordis')
  const installAnchor = path.join(process.env.DSH_INSTALL_DIR, 'package.json')
  const home = path.dirname(path.dirname(directory))
  assert.equal(boot.resolveProfileDir(path.basename(directory), home), directory)
  const profile = boot.loadProfile('trash-profile-boot', path.basename(directory), installAnchor, home)
  // Desktop's actual entry uses loadProfileDirectory; compare both read paths.
  assert.deepEqual(profile, boot.loadProfileDirectory('trash-profile-boot', directory, installAnchor))
  const layer = profile.layers.find(row => row.packageName === manifest.name)
  assert.ok(layer, `Real dsh.profile.bundles must load ${manifest.name}`)
  const linkedPackage = path.join(directory, 'node_modules', manifest.name)
  assert.ok(fs.lstatSync(linkedPackage).isSymbolicLink(), 'Exercise the real link: installation')
  assert.equal(fs.realpathSync(linkedPackage), root, 'Real profile must point to this checkout')
  const profileManifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  assert.ok(profileManifest.dependencies[manifest.name].startsWith('link:'))
  const resolution = await boot.createRuntimeResolution({ installAnchor, profile, home })
  const patches = boot.readProfilePatches('trash-profile-boot', {
    name: profile.name, dir: directory, patchPath: profile.patchPath, installAnchor,
    startedBundles: profile.layers.map(row => row.packageName), cwd: root, home, overlays: [],
  }, profile)
  const entries = boot.composeEntries([patches])
  const relevant = new Set(['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-typert-loader',
    '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-storage-domain', manifest.name])
  const selected = entries.filter(row => relevant.has(row.name))
  assert.equal(selected.length, relevant.size, 'Every required row must occur once in real composition')
  emit('real-profile-resolution', {
    profile: directory, dependency: profileManifest.dependencies[manifest.name],
    linkedRoots: resolution.linkedRoots.filter(row => row.name === manifest.name),
    localPackageNames: resolution.localPackageNames.filter(name => name === manifest.name),
    // Bundle roots are intentionally removed from the mapping; native profile lookup owns them.
    entries: resolution.entries.filter(row => row.name === manifest.name),
    selected: selected.map(row => ({ id: row.id, name: row.name })),
  })

  ctx = new Context()
  ctx.baseUrl = url(directory)
  await ctx.plugin(installed('@deepseek-ai/cordis-plugin-loader').default)
  const packages = new boot.PluginPackages(ctx, { resolution })
  const medium = new Map(), archived = new Set(), operations = [], events = []
  ctx.provide('storage', { backend: { get(name) {
    assert.equal(name, 'json') // real storage-domain config; medium stays in memory
    return { kv: { async open() { return {
      async loadAll() { return { global: null, tables: { trash: Object.fromEntries(medium) } } },
      async putRecord(table, id, value) { operations.push(`put:${id}`); medium.set(id, structuredClone(value)) },
      async close() {},
    } } } }
  } } })
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [...archived] },
    async archiveSession(id, options) {
      assert.deepEqual(options, { stopActivity: true })
      operations.push(`archive:${id}`); archived.add(id)
    },
  })
  ctx.provide('sessionPersistence', { async stat() { return undefined }, async list() { return [] } })
  ctx.provide('remoteAccess', { decide() { assert.fail('Owner calls must not need a policy stub') } })
  ctx.on('internal/plugin', fiber => {
    const name = fiber.entry?.options.name
    if (name) events.push(name)
  })
  for (const [anchor, baseUrl] of [['profile', url(directory)], ['linked-root', url(root)],
    ['installation', url(process.env.DSH_INSTALL_DIR)]]) {
    const found = packages.packageOf(manifest.name, baseUrl)
    emit('real-profile-packageOf', { anchor, baseUrl, result: found?.dir ?? null })
    assert.equal(Boolean(found), anchor === 'profile')
  }
  // Preserve real order/options and root cordis.yml, but never start unrelated plugins.
  // No bareModuleBaseUrl override: this is the actual Desktop -> runProfile -> boot path.
  await boot.mountRootInclude(ctx, path.join(directory, 'cordis.yml'), [{ insert: selected }])
  await ctx.loader.await()
  // Manifest imports in internal/plugin observers are not Loader entry tasks.
  for (let turn = 0; turn < 200 && !ctx.typert.local.get(endpoint); turn++) await tick()
  for (const name of relevant) {
    const row = [...ctx.loader.entries()].find(row => row.options.name === name)
    assert.ok(row?.fiber, `${name}: missing fiber`)
    assert.equal(row.fiber.state, FiberState.ACTIVE, `${name}: fiber must be ACTIVE`)
    assert.equal(row.parent.tree.ctx.baseUrl, url(directory))
  }
  assert.ok(ctx.get('trash'), 'Host class must provide trash, not merely a Loader row')
  assert.ok(ctx.typert.getPackage(manifest.name), 'Host manifest must be registered')
  assert.ok(ctx.typert.local.get(endpoint), 'Strict invocation must be registered')
  const gateway = ctx.get('typertGateway')
  // Probe actual installed implementation, including its private SRC branch.
  assert.equal(gateway.resolveSrcDescriptor('trash', 'trashSession', endpoint).service, 'trash')
  await gateway.invoke({ namespace: 'trash', method: 'trashSession', args: { sessionId: 'strict-probe' }, peer })
  assert.equal(medium.has('strict-probe'), true)
  assert.equal(archived.has('strict-probe'), true)
  emit('real-profile-host-boot', { provided: true, manifest: true, strict: true, src: true,
    gatewayInvoke: 'ok', events, operations: [...operations] })

  // A: remove the scanner and use a fresh registry (hasSeen forbids fallback for withdrawn strict IDs).
  const scanner = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-typert-loader')
  await scanner.fiber.dispose()
  assert.equal(ctx.typert.local.get(endpoint), undefined)
  assert.equal(ctx.typert.local.hasSeen(endpoint), true)
  await assert.rejects(gateway.invoke({ namespace: 'trash', method: 'trashSession',
    args: { sessionId: 'withdrawn-probe' }, peer }), error => error.code === 'gateway/definition-unavailable')
  // A catalog-only absence is not equivalent to B, and can have two distinct dispatch outcomes.
  const registryRow = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-typert-registry')
  await registryRow.fiber.dispose()
  new (installed('@deepseek-ai/dsh-typert-registry').TypertRegistry)(ctx)
  await ctx.loader.await()
  assert.equal(ctx.typert.local.get(endpoint), undefined)
  assert.equal(ctx.typert.local.hasSeen(endpoint), false)
  assert.ok(ctx.get('trash'))
  await gateway.invoke({ namespace: 'trash', method: 'trashSession', args: { sessionId: 'src-probe' }, peer })
  assert.ok(medium.has('src-probe'))
  emit('A-service-without-manifest', { provided: true, strict: false, srcInvoke: 'ok',
    withdrawnStrictError: 'gateway/definition-unavailable' })

  // B: remove an injected provider; the same Loader row survives but cannot construct its class.
  const storageRow = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-storage-domain')
  await storageRow.fiber.dispose()
  await ctx.loader.await()
  assert.equal(ctx.get('trash'), undefined)
  const trashRow = [...ctx.loader.entries()].find(row => row.options.name === manifest.name)
  assert.ok(trashRow.fiber)
  assert.equal(trashRow.fiber.state, FiberState.PENDING)
  assert.throws(() => gateway.resolveSrcDescriptor('trash', 'trashSession', endpoint),
    error => error.code === 'gateway/invocation-unavailable')
  emit('B-missing-provider', { provided: false, loaderFiberExists: true, fiberState: 'PENDING',
    srcError: 'gateway/invocation-unavailable' })
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(async () => {
  try {
    await ctx?.fiber.dispose()
    assert.deepEqual(hashes(), before, 'Protected documents and profile files must remain unchanged')
    assert.deepEqual(blocked, [], 'No write outside the fixture may even be attempted')
    emit('real-profile-read-only', { unchanged: true, externalWriteAttempts: blocked.length })
  } catch (error) { console.error(error.stack); process.exitCode = 1 }
  finally {
    restorers.reverse().forEach(restore => restore())
    syncBuiltinESMExports()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
