// Usage: node scripts/compatibility.mjs <extracted npm-pack directory>
// Each child directory: deepseek-ai-<name>-<version>/package/{package.json,src,lib}.
// Downloads/extraction are explicit; never installs into a DSH profile.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import workspaceEvidence from './workspace-evidence.cjs'
import platformEvidence from './platform-evidence.cjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packs = process.argv[2]
assert.ok(packs, 'Pass the directory of extracted rc.2/rc.5 npm packs')
const packages = ['dsh-session', 'dsh-session-persistence', 'dsh-session-persistence-jsonl',
  'dsh-storage', 'dsh-storage-domain', 'dsh-workspace', 'dsh-typert-protocol',
  'dsh-api-workspace-controller', 'dsh-api-session-controller',
  'dsh-client-ui-workspace', 'dsh-client-ui-conversation', 'dsh-deque', 'dsh-api-gateway',
  'dsh-client-ui-sidebar', 'dsh-client-ui-layout', 'dsh-client-ui-slots', 'dsh-util-workspace-path']
const source = (pkg, version) => join(resolve(packs), `deepseek-ai-${pkg}-${version}`, 'package')
const link = (target, dest) => symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir')
const emit = (check, data) => console.log(JSON.stringify({ check, ...data }))
// Compare every authored source, including tsx, with explicit expected delta.
function files(directory, relative = '') {
  return readdirSync(join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name)
    return entry.isDirectory() ? files(directory, name) : [name]
  }).sort()
}
for (const pkg of packages) {
  const a = join(source(pkg, '0.2.2-rc.2'), 'src'), b = join(source(pkg, '0.2.2-rc.5'), 'src')
  const names = [...new Set([...files(a), ...files(b)])].sort()
  const different = names.filter(name => {
    try { return !readFileSync(join(a, name)).equals(readFileSync(join(b, name))) } catch { return true }
  })
  const expected = {
    'dsh-client-ui-workspace': ['client/WorkspacePicker.tsx', 'client/contract/slots.ts', 'client/index.ts'],
    'dsh-client-ui-sidebar': ['client/SidebarRoot.module.css', 'client/SidebarRoot.tsx', 'client/contract/slots.ts', 'client/index.ts'],
  }[pkg] ?? []
  assert.deepEqual(different, expected.map(name => name.split('/').join(process.platform === 'win32' ? '\\' : '/')).sort(), `${pkg}: unexpected API/source drift`)
  emit('packed-source-comparison', { pkg, different })
}
for (const version of ['0.2.2-rc.2', '0.2.2-rc.5']) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'trash-compatibility-')))
  try {
    for (const name of ['package.json', 'tsconfig.json', 'src', 'dist', 'scripts', 'locale']) {
      cpSync(join(root, name), join(temporary, name), { recursive: true })
    }
    const modules = join(temporary, 'node_modules')
    mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
    for (const entry of readdirSync(join(root, 'node_modules'))) {
      if (entry !== '@deepseek-ai') link(realpathSync(join(root, 'node_modules', entry)), join(modules, entry))
    }
    for (const entry of readdirSync(join(root, 'node_modules', '@deepseek-ai'))) {
      if (!packages.includes(entry)) link(realpathSync(join(root, 'node_modules', '@deepseek-ai', entry)), join(modules, '@deepseek-ai', entry))
    }
    for (const pkg of packages) {
      const manifest = JSON.parse(readFileSync(join(source(pkg, version), 'package.json')))
      assert.equal(manifest.version, version)
      cpSync(source(pkg, version), join(modules, '@deepseek-ai', pkg), { recursive: true })
    }
    const installed = createRequire(join(temporary, 'package.json'))
    await workspaceEvidence(installed, (check, data) => emit(check, { version, ...data }))
    await platformEvidence(installed, (check, data) => emit(check, { version, ...data }))
    // Real peer code from the tarballs, other dependencies supplied by the
    // pinned development tree. This is an isolated compatibility matrix, not
    // an entire rc.2 Desktop distribution or GUI acceptance test.
    for (const entry of [join(root, 'node_modules/typescript/bin/tsc'),
      join(temporary, 'scripts/generate-typert.mjs'), join(temporary, 'scripts/build-client.mjs'),
      join(temporary, 'scripts/smoke.mjs')]) {
      const result = spawnSync(process.execPath, [entry], { cwd: temporary, encoding: 'utf8', timeout: 120_000 })
      if (result.status !== 0) process.stderr.write(result.stdout + result.stderr)
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, `${version}: ${entry}`)
      const lines = result.stdout.trim().split('\n')
      emit('compatibility-command', { version, entry: entry.split(/[\\/]/).pop(), summaries: lines.filter(line => /isolated|explicitly skipped|Typert:|Client:/.test(line)) })
    }
    for (const name of ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']) {
      assert.equal(readFileSync(join(temporary, 'dist', name), 'utf8'), readFileSync(join(root, 'dist', name), 'utf8'), `${version}: generated ${name}`)
    }
    emit('compatibility-version', { version, result: 'PASS', realPeers: packages, profileTouched: false })
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
