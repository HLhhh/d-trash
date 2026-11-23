// Read installed sources with Electron's ASAR-aware fs; all lock/I/O probes
// use synthetic temporary directories. Never imports a TS file by assumption.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

module.exports = async (installed, emit) => {
  const source = installed.resolve('@deepseek-ai/dsh-session-persistence-jsonl/src/lease.ts')
  try {
    const { SessionWriteLease } = await import(pathToFileURL(source).href)
    assert.equal(typeof SessionWriteLease.acquire, 'function')
    emit('official-lease-import', { ok: true })
  } catch (error) {
    assert.equal(error.code, 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING')
    emit('official-lease-import', { ok: false, code: error.code })
  }
  // Execute the actual installed lease, transpiled only for this probe, with
  // its real dependencies. This is not the plugin's production loading path.
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(
      id => id.startsWith('.') ? load(path.resolve(path.dirname(file), id)) : installed(id), module, module.exports)
    return module.exports
  }
  const { SessionWriteLease } = load(source)
  const { acquireWriteLease } = await import('../dist/write-lease.js')
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trash-lease-probe-')))
  let official, plugin
  try {
    fs.writeFileSync(path.join(directory, 'session.lock'), '')
    official = await SessionWriteLease.acquire(directory, 'synthetic')
    await assert.rejects(acquireWriteLease(directory), /busy/)
    await official.release(); official = undefined
    plugin = await acquireWriteLease(directory)
    await assert.rejects(SessionWriteLease.acquire(directory, 'synthetic'), error =>
      error.name === 'SessionAlreadyOwnedError')
    await plugin.release(); plugin = undefined
    official = await SessionWriteLease.acquire(directory, 'synthetic')
    emit('official-lease-mutual-exclusion', { platform: process.platform, bothDirections: true, reacquire: true })
  } finally {
    await plugin?.release(); await official?.release()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
