import assert from 'node:assert/strict'
import { lstat, readFile, rm, rename, symlink, mkdir } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { retrySharing } from '../dist/fs-retry.js'
import { acquireWriteLease } from '../dist/write-lease.js'
import { fixture } from './phase4-fixture.mjs'

let count = 0, skipped = 0
async function test(name, run, windowsOnly = false) {
  if (windowsOnly && process.platform !== 'win32') {
    skipped++; console.log(`SKIP: platform ${name} (requires native Windows)`); return
  }
  const f = await fixture()
  try { await run(f); count++; console.log(`PASS: platform ${name}`) }
  finally { await f.dispose() }
}

await test('locate/audit needs no session.lock; purge uses platform writer contract', async f => {
  await f.create()
  await rm(join(f.directory('a'), 'session.lock'))
  assert.equal(await f.trash.purger.home('a'), f.home)
  await f.trash.restoreSession('a'); await f.trash.trashSession('a')
  const audit = (await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(audit.length, 3)
  assert.equal(f.fallbacks.length, 0)
  if (process.platform === 'win32') {
    assert.equal(await f.trash.removeFromTrash('a'), true)
    await assert.rejects(lstat(f.directory('a')), { code: 'ENOENT' })
  } else {
    await assert.rejects(f.trash.removeFromTrash('a'), /\[lock\].*ENOENT/)
    assert.ok(f.medium.has('a'))
  }
})

await test('retry policy bounds sharing failures and never retries EXDEV or POSIX', async () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']) {
    let attempts = 0
    const result = await retrySharing(async () => { if (++attempts < 3) throw Object.assign(new Error(code), { code }); return 7 }, 'win32')
    assert.equal(result, 7); assert.equal(attempts, 3)
  }
  for (const [platform, code, expected] of [['win32', 'EPERM', 5], ['win32', 'EXDEV', 1], ['darwin', 'EBUSY', 1]]) {
    let attempts = 0
    await assert.rejects(retrySharing(async () => { attempts++; throw Object.assign(new Error(code), { code }) }, platform), { code })
    assert.equal(attempts, expected)
  }
})

await test('rename failure preserves unmoved intent; later purge completes', async f => {
  await f.create()
  const rename = f.trash.purger.systemTrash.move.bind(f.trash.purger.systemTrash)
  f.trash.purger.systemTrash.move = async () => { throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' }) }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[moved-to-trash\].*sharing violation/)
  assert.ok(f.medium.get('a').purge)
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  f.trash.purger.systemTrash.move = rename
  assert.equal(await f.trash.removeFromTrash('a'), true)
})

await test('native lease releases after holder process termination', async f => {
  await f.create()
  const child = spawn(process.execPath, [fileURLToPath(new URL('./phase4-child.mjs', import.meta.url)),
    'lock', f.directory('a')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data)),
      once(child, 'exit').then(([code]) => { throw new Error(`Lease holder exited ${code}: ${stderr}`) }),
    ])
    assert.match(ready, /LOCKED/)
    await assert.rejects(acquireWriteLease(f.directory('a')), /busy/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited
    }
  }
  assert.equal(await f.trash.removeFromTrash('a'), true)
})

await test('Windows case-folded semaphore excludes path aliases without lock file', async f => {
  await f.create(); await rm(join(f.directory('a'), 'session.lock'))
  const writer = await acquireWriteLease(f.directory('a'))
  try {
    await assert.rejects(acquireWriteLease(f.directory('a').toUpperCase()), /busy/)
    await assert.rejects(lstat(join(f.directory('a'), 'session.lock')), { code: 'ENOENT' })
  } finally { await writer.release() }
}, true)

await test('Windows junction session path is refused with payload preserved', async f => {
  await f.create()
  const displaced = join(f.home, 'displaced')
  await rename(f.directory('a'), displaced)
  await symlink(displaced, f.directory('a'), 'junction')
  await assert.rejects(f.trash.removeFromTrash('a'), /Move to system trash/)
  assert.equal(await readFile(join(displaced, 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  assert.ok(f.medium.has('a'))
}, true)

await test('Windows transient move errors retry with no marker loss', async f => {
  await f.create(); await rm(join(f.directory('a'), 'session.lock'))
  let attempts = 0
  f.hooks.move = async () => {
    if (++attempts < 3) throw Object.assign(new Error('sharing'), { code: 'EBUSY' })
  }
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.equal(attempts, 3); assert.equal(f.medium.has('a'), false)
}, true)

await test('Windows rename retry rechecks archive gate', async f => {
  await f.create()
  f.hooks.move = async () => {
    f.archived.delete('a')
    throw Object.assign(new Error('sharing'), { code: 'EBUSY' })
  }
  await assert.rejects(f.trash.removeFromTrash('a'), /still archived/)
  assert.ok(f.medium.get('a').purge)
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
}, true)

await test('Windows staged recovery respects original-path writer semaphore', async f => {
  await f.create()
  const identity = await lstat(f.directory('a'), { bigint: true })
  const staging = join(f.home, 'sessions.trash-purge-staging')
  await mkdir(staging)
  const target = join(staging, 'a-legacy')
  await rename(f.directory('a'), target)
  const table = (await f.trash.domain()).table('trash')
  await table.put('a', { ...table.get('a'), purge: { source: f.directory('a'), target,
    dev: String(identity.dev), ino: String(identity.ino), deleting: false, logsDeleted: false } })
  const writer = await acquireWriteLease(f.directory('a'))
  try {
    await assert.rejects(f.trash.removeFromTrash('a'), /busy/)
    assert.ok(await lstat(target)); assert.ok(f.medium.has('a'))
  } finally { await writer.release() }
  assert.equal(await f.trash.removeFromTrash('a'), true)
}, true)

await test('Windows real deny-delete handles allow injected move after bounded retry', async f => {
  const koffi = (await import('koffi')).default
  const api = koffi.load('kernel32.dll')
  const create = api.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr'])
  const close = api.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
  async function whileOccupied(file, action) {
    // GENERIC_READ, FILE_SHARE_READ|FILE_SHARE_WRITE (no SHARE_DELETE),
    // OPEN_EXISTING. Exercise real Windows sharing semantics, no error seam.
    const handle = create(toNamespacedPath(file), 0x80000000, 3, null, 3, 0x80, 0)
    assert.ok(handle !== -1 && handle !== 0, 'CreateFileW must hold a real deny-delete handle')
    let released = false
    const release = () => { if (!released) { released = true; assert.equal(close(handle), 1) } }
    const timer = setTimeout(release, 250)
    try {
      await action()
      assert.equal(released, true, 'deletion cannot complete while Windows denies file deletion')
    } finally { clearTimeout(timer); release() }
  }
  await f.create('a')
  await whileOccupied(f.log('a'), () => f.trash.removeFromTrash('a'))
  assert.equal(f.medium.size, 0)
}, true)

console.log(`PASS: platform ${count} scenarios; ${skipped} explicitly skipped; synthetic homes only`)
