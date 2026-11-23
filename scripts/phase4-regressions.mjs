import assert from 'node:assert/strict'
import { lstat, open, readFile, readdir, rename, rm, mkdir, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireWriteLease } from '../dist/write-lease.js'
import { fixture } from './phase4-fixture.mjs'
const exists = async path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
// Installed JSONL listProjectDirs/listSessionDirs rules: all root directories
// are projects, including dot directories; all project directories are sessions.
// No header decoding is needed: a directory outside these candidates cannot be listed.
const discoverSessionDirs = async root => {
  const projects = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const sessions = await Promise.all(projects.map(async project => {
    const path = join(root, project.name)
    const entries = await readdir(path, { withFileTypes: true })
    assert.equal(entries.some(entry => entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name)), false,
      'JSONL rejects legacy flat-file layouts')
    return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
  }))
  return sessions.flat().sort()
}
const barrier = () => {
  let enter, release
  const arrived = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  return { arrived, release, async wait() { enter(); await gate } }
}
let count = 0, skipped = 0
async function test(name, run) {
  if (process.platform === 'win32' && /reject symlink|reject missing-lock|ancestor symlink|SIGKILL/.test(name)) {
    skipped++; console.log(`SKIP: phase4 ${name} (POSIX symlink/O_NOFOLLOW, existing lock-file or SIGKILL contract)`); return
  }
  const f = await fixture()
  let deadline
  const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 15000) })
  try {
    await Promise.race([run(f), timeout])
    const disk = (await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')).trimEnd().split('\n').map(JSON.parse)
    for (const event of f.logs) assert.ok(disk.some(row => row.sessionId === event.sessionId
      && row.stage === event.stage && row.result === event.result && (row.reason ?? '') === event.error),
    `Host report must be on disk: ${JSON.stringify(event)}`)
    count++; console.log(`PASS: phase4 ${name}`)
  }
  finally { clearTimeout(deadline); await f.dispose() }
}
const unchanged = async (f, id = 'a') => {
  assert.equal(await readFile(f.log(id), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  assert.equal(f.medium.has(id), true)
  assert.equal(await exists(join(f.directory(id), 'session.lock')), true)
}

await test('physical deletion cleans all generations, ownership, archive, marker and cache in order', async f => {
  const id = process.platform === 'win32' ? 'im-link-synthetic' : 'im-link:synthetic'
  await f.create(id)
  const before = await lstat(f.directory(id), { bigint: true })
  f.hooks.put = async (key, record) => {
    if (!record.purge || record.purge.deleting) return
    await assert.rejects(acquireWriteLease(f.directory(id)), /busy/)
  }
  const remove = f.trash.purger.removeDirectory.bind(f.trash.purger)
  f.trash.purger.removeDirectory = async path => {
    const moved = await lstat(path, { bigint: true })
    assert.equal(moved.ino, before.ino); assert.equal(moved.dev, before.dev)
    const lock = await acquireWriteLease(path) // Original lease was released before rm.
    await lock.release()
    assert.equal(f.medium.has(id), true); assert.equal(f.archived.has(id), true)
    await remove(path)
  }
  assert.equal(await f.trash.removeFromTrash(id), true)
  assert.equal(await exists(f.directory(id)), false)
  assert.equal(await exists(f.cache(id)), false)
  assert.equal(f.medium.has(id), false); assert.equal(f.archived.has(id), false); assert.equal(f.members.has(id), false)
  assert.deepEqual(await f.trash.listTrash(), [])
  const stages = f.logs.map(row => row.stage)
  assert.ok(stages.indexOf('locked') < stages.indexOf('renamed'))
  assert.ok(stages.indexOf('renamed') < stages.indexOf('unlocked'))
  assert.ok(stages.indexOf('unlocked') < stages.indexOf('logs-deleted'))
  assert.ok(stages.indexOf('logs-deleted') < stages.indexOf('detach'))
})

await test('stat locates and deletes without DSH_HOME, including sibling staging and projection cache', async f => {
  assert.equal(process.env.DSH_HOME, undefined)
  await f.create()
  let captured
  f.hooks.put = (id, record) => { if (record.purge) captured = record.purge }
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.equal(captured.source, f.directory('a'))
  assert.equal(dirname(captured.target), join(f.home, 'sessions.trash-purge-staging'))
  assert.equal(await exists(f.directory('a')), false)
  assert.equal(await exists(captured.target), false)
  assert.equal(await exists(f.cache('a')), false)
  assert.equal(f.medium.has('a'), false)
  assert.ok(f.logs.some(row => row.stage === 'projection' && row.result === 'ok'))
})

await test('detach skips unrelated workspaces and preserves other sessions without no-op log rows', async f => {
  await f.create('a'); await f.create('b')
  f.hooks.detach = (id, index) => assert.equal(index, 0, 'unrelated workspace must not be called')
  await f.trash.removeFromTrash('a')
  assert.deepEqual(f.calls.filter(call => call.startsWith('detach:')), ['detach:0'])
  assert.equal(f.logs.filter(row => row.stage === 'detach').length, 1)
  assert.equal(f.members.has('b'), true)
  assert.equal(f.medium.has('b'), true)
  assert.equal(await readFile(f.log('b'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
})

await test('unowned session still purges without detach calls or synthetic detach logs', async f => {
  await f.create()
  f.members.delete('a')
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.deepEqual(f.calls.filter(call => call.startsWith('detach:')), [])
  assert.deepEqual(f.logs.filter(row => row.stage === 'detach'), [])
  assert.equal(await exists(f.directory('a')), false)
  assert.equal(await exists(f.cache('a')), false)
  assert.equal(f.archived.has('a'), false)
  assert.equal(f.medium.has('a'), false)
})

await test('all owning workspaces are attempted after a detach failure and retry skips completed owners', async f => {
  await f.create()
  let denied = true
  const owners = [new Set(['a']), new Set(['a'])]
  owners.forEach((ids, index) => f.workspaces.push({
    get sessionIds() { return [...ids] },
    async detachSession(id) {
      f.calls.push(`detach:${index + 2}`)
      if (index === 0 && denied) throw new Error('owning workspace denied')
      ids.delete(id)
    },
  }))
  await assert.rejects(f.trash.removeFromTrash('a'), /\[detach\].*owning workspace denied/)
  assert.deepEqual(f.calls.filter(call => call.startsWith('detach:')), ['detach:0', 'detach:2', 'detach:3'])
  assert.equal(owners[0].has('a'), true); assert.equal(owners[1].has('a'), false)
  assert.equal(f.medium.get('a').purge.logsDeleted, true)
  assert.equal(f.archived.has('a'), true)
  assert.equal(await exists(f.directory('a')), false)
  denied = false
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.deepEqual(f.calls.filter(call => call.startsWith('detach:')), ['detach:0', 'detach:2', 'detach:3', 'detach:2'])
  assert.equal(f.medium.has('a'), false)
  assert.equal(f.logs.filter(row => row.stage === 'detach' && row.result === 'ok').length, 3)
})

await test('wrong DSH_HOME cannot redirect stat-derived deletion or receipt recovery and cache cleanup', async f => {
  const wrong = join(f.home, 'wrong-home')
  const wrongSource = join(wrong, 'sessions', 'synthetic-cwd', 'a')
  const wrongCache = join(wrong, 'storages', 'session_projcache', 'sessions', 'a.json')
  await mkdir(wrongSource, { recursive: true })
  await writeFile(join(wrongSource, 'session.v4.jsonl'), 'SYNTHETIC WRONG HOME')
  await mkdir(dirname(wrongCache), { recursive: true })
  await writeFile(wrongCache, 'SYNTHETIC WRONG CACHE')
  process.env.DSH_HOME = wrong
  await f.create()
  const remove = f.trash.purger.removeDirectory.bind(f.trash.purger)
  f.trash.purger.removeDirectory = async () => { throw new Error('injected rm failure') }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[delete-staged\].*injected rm failure/)
  const intent = f.medium.get('a').purge
  assert.equal(intent.source, f.directory('a'))
  assert.equal(dirname(intent.target), join(f.home, 'sessions.trash-purge-staging'))
  assert.equal(await exists(f.directory('a')), false)
  // Once renamed, stat need not be available: recovery derives home from the
  // validated receipt, even with a valid but unrelated environment home.
  f.hooks.stat = () => { throw new Error('No stat after rename') }
  f.trash.purger.removeDirectory = remove
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.equal(await exists(intent.target), false)
  assert.equal(await exists(f.cache('a')), false)
  assert.equal(f.medium.has('a'), false)
  assert.equal(await readFile(join(wrongSource, 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC WRONG HOME')
  assert.equal(await readFile(wrongCache, 'utf8'), 'SYNTHETIC WRONG CACHE')
  assert.equal(await exists(join(wrong, 'sessions.trash-purge-staging')), false)
})

for (const mode of ['not-trash', 'unarchived', 'outside', 'extra-level', 'missing-level', 'wrong-id', 'no-location',
  'symlink-home', 'symlink-root', 'symlink-slug', 'symlink-directory', 'symlink-log', 'symlink-lock', 'missing-lock', 'symlink-staging']) {
  await test(`reject ${mode} without deleting payloads`, async f => {
    await f.create()
    if (mode === 'not-trash') {
      const table = (await f.trash.domain()).table('trash'); await table.delete('a')
    }
    if (mode === 'unarchived') f.archived.delete('a')
    if (mode === 'outside') {
      const dir = join(f.home, 'outside'); await mkdir(dir); await writeFile(join(dir, 'session.jsonl'), 'OUTSIDE')
      f.hooks.stat = () => ({ header: { id: 'a' }, location: { kind: 'jsonl', path: join(dir, 'session.jsonl') } })
    }
    if (mode === 'extra-level' || mode === 'missing-level') {
      const dir = mode === 'extra-level' ? join(f.home, 'sessions', 'synthetic-cwd', 'extra', 'a')
        : join(f.home, 'sessions', 'a')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.jsonl'), 'SYNTHETIC INVALID DEPTH')
      f.hooks.stat = () => ({ header: { id: 'a' }, location: { kind: 'jsonl', path: join(dir, 'session.jsonl') } })
    }
    if (mode === 'wrong-id') f.hooks.stat = () => ({ header: { id: 'b' }, location: { kind: 'jsonl', path: f.log('a') } })
    if (mode === 'no-location') f.hooks.stat = () => ({ header: { id: 'a' } })
    if (mode === 'symlink-home') {
      const alias = join(f.home, 'home-alias')
      await symlink(f.home, alias)
      f.hooks.stat = () => ({ header: { id: 'a' }, location: { kind: 'jsonl', path: join(alias, 'sessions', 'synthetic-cwd', 'a', 'session.v4.jsonl') } })
    }
    if (mode === 'symlink-root' || mode === 'symlink-slug') {
      const path = mode === 'symlink-root' ? join(f.home, 'sessions') : dirname(f.directory('a'))
      const displaced = join(f.home, 'displaced')
      await rename(path, displaced)
      await symlink(displaced, path)
    }
    if (mode === 'symlink-directory') {
      await rename(f.directory('a'), join(f.home, 'outside'))
      await symlink(join(f.home, 'outside'), f.directory('a'))
    }
    if (mode === 'symlink-log') {
      const displaced = join(f.home, 'outside-log')
      await rename(f.log('a'), displaced)
      await symlink(displaced, f.log('a'))
    }
    if (mode === 'symlink-lock') {
      await rm(join(f.directory('a'), 'session.lock'))
      await writeFile(join(f.home, 'outside-lock'), '')
      await symlink(join(f.home, 'outside-lock'), join(f.directory('a'), 'session.lock'))
    }
    if (mode === 'missing-lock') await rm(join(f.directory('a'), 'session.lock'))
    if (mode === 'symlink-staging') {
      await mkdir(join(f.home, 'outside')); await symlink(join(f.home, 'outside'), join(f.home, 'sessions.trash-purge-staging'))
    }
    await assert.rejects(f.trash.removeFromTrash('a'), /Physical deletion/)
    assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
    assert.equal(f.medium.has('a'), mode !== 'not-trash')
    if (mode === 'outside') assert.equal(await readFile(join(f.home, 'outside', 'session.jsonl'), 'utf8'), 'OUTSIDE')
  })
}

await test('external process native lease contention refuses, preserves inode and permits retry after close', async f => {
  await f.create()
  const lockPath = join(f.directory('a'), 'session.lock'), before = await lstat(lockPath, { bigint: true })
  const child = spawn(process.execPath, [fileURLToPath(new URL('./phase4-child.mjs', import.meta.url)), 'lock', f.directory('a')], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  let stderr = ''; child.stderr.on('data', value => { stderr += value })
  try {
    const [data] = await once(child.stdout, 'data'); assert.match(String(data), /LOCKED/, stderr)
    await assert.rejects(f.trash.removeFromTrash('a'), /\[lock\].*busy/)
    assert.equal((await lstat(lockPath, { bigint: true })).ino, before.ino)
    await unchanged(f)
  } finally { const exited = once(child, 'exit'); child.stdin.end('release'); await exited }
  assert.equal(await f.trash.removeFromTrash('a'), true)
})

await test('directory substitution between stat and flock recheck refuses', async f => {
  await f.create()
  let reads = 0
  f.hooks.stat = async () => {
    if (++reads === 2) {
      await rename(f.directory('a'), join(f.home, 'original'))
      await mkdir(f.directory('a')); await writeFile(f.log('a'), 'REPLACEMENT'); await writeFile(join(f.directory('a'), 'session.lock'), '')
    }
  }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[recheck\].*identity/)
  assert.equal(await readFile(f.log('a'), 'utf8'), 'REPLACEMENT')
  assert.equal(await readFile(join(f.home, 'original', 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
})

await test('native unarchive during durable intent is caught before rename', async f => {
  await f.create()
  f.hooks.put = (id, record) => { if (record.purge) f.archived.delete(id) }
  await assert.rejects(f.trash.removeFromTrash('a'), /still archived/)
  await unchanged(f)
  delete f.hooks.put
  // Next maintenance drops the unmoved receipt, then enforces the archive gate.
  await assert.rejects(f.trash.removeFromTrash('a'), /still archived/)
  assert.equal(f.medium.get('a').purge, undefined)
})

await test('ancestor symlink substituted during intent is refused before rename', async f => {
  await f.create()
  const root = join(f.home, 'sessions'), displaced = join(f.home, 'displaced-sessions')
  f.hooks.put = async (id, record) => {
    if (!record.purge) return
    await rename(root, displaced)
    await symlink(displaced, root)
  }
  await assert.rejects(f.trash.removeFromTrash('a'), /symlink/)
  assert.equal(await readFile(join(displaced, 'synthetic-cwd', 'a', 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
})

await test('failed durable intent never renames or deletes the session', async f => {
  await f.create()
  f.hooks.put = (id, record) => { if (record.purge) throw new Error('intent unavailable') }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[intent\].*intent unavailable/)
  await unchanged(f)
  assert.equal(f.medium.get('a').purge, undefined)
})

await test('SIGKILL immediately after real rename leaves recoverable staging and marker', async f => {
  await f.create()
  await f.create('b')
  const root = join(f.home, 'sessions')
  assert.deepEqual(await discoverSessionDirs(root), [f.directory('a'), f.directory('b')])
  const child = spawn(process.execPath, [fileURLToPath(new URL('./phase4-child.mjs', import.meta.url)), 'crash', f.home], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  let stderr = ''; child.stderr.on('data', value => { stderr += value })
  const [code, signal] = await once(child, 'exit')
  assert.equal(signal, 'SIGKILL', `unexpected ${code}: ${stderr}`)
  const audit = (await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')).trimEnd().split('\n').map(JSON.parse)
  assert.ok(audit.some(row => row.action === 'removeFromTrash' && row.sessionId === 'a'
    && row.stage === 'renamed' && row.result === 'ok'), 'rename event must survive process death')
  assert.equal(await exists(f.directory('a')), false)
  const staging = join(f.home, 'sessions.trash-purge-staging')
  assert.equal((await readdir(staging)).length, 1)
  const diskMarkers = JSON.parse(await readFile(join(f.home, 'markers.json'), 'utf8'))
  assert.ok(diskMarkers.a.purge)
  assert.equal(dirname(diskMarkers.a.purge.target), staging)
  assert.equal(await readFile(join(diskMarkers.a.purge.target, 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  assert.deepEqual(await discoverSessionDirs(root), [f.directory('b')],
    'crash residue must be outside real JSONL discovery candidates, while other sessions stay visible')
  const restarted = await fixture(f.home)
  try {
    assert.deepEqual(await discoverSessionDirs(root), [f.directory('b')], 'restart must not rediscover staged sessions')
    // Any purge invocation recovers previous staged payloads before its own gate.
    await assert.rejects(restarted.trash.removeFromTrash('unknown'), /not in trash/)
    assert.deepEqual(await readdir(staging), [])
    assert.equal(restarted.medium.get('a').purge.logsDeleted, true)
    const visible = (await restarted.trash.listTrash())[0][1]
    assert.equal(visible.purgePending, true)
    assert.equal(visible.purge, undefined, 'private filesystem paths must not cross Remote')
    assert.ok(restarted.logs.some(row => row.stage === 'recovery' && row.result === 'deleted'))
    assert.equal(await restarted.trash.removeFromTrash('a'), true)
  } finally { await restarted.dispose(true) }
})

await test('recovery rejects persisted targets outside the direct sibling staging and retains credentials', async f => {
  await f.create()
  const identity = await lstat(f.directory('a'), { bigint: true })
  const table = (await f.trash.domain()).table('trash'), original = table.get('a')
  for (const parent of [join(f.home, 'sessions', '.trash-purge-staging'),
    join(f.home, 'outside'), join(f.home, 'sessions.trash-purge-staging', 'nested')]) {
    const intent = { source: f.directory('a'), target: join(parent, 'a-synthetic'),
      dev: String(identity.dev), ino: String(identity.ino), deleting: false, logsDeleted: false }
    await table.put('a', { ...original, purge: intent })
    await assert.rejects(f.trash.removeFromTrash('a'), /Unsafe persisted purge intent/)
    assert.deepEqual(f.medium.get('a').purge, intent)
    assert.equal((await f.trash.listTrash())[0][1].purgePending, true)
    assert.ok(f.logs.some(row => row.stage === 'recovery' && row.result === 'failed'
      && row.error.includes('Unsafe persisted purge intent')))
    await unchanged(f)
  }
})

await test('discovery includes legacy dot projects but recovery never sweeps uncredentialed staging', async f => {
  await f.create()
  const legacy = join(f.home, 'sessions', '.trash-purge-staging', 'a-legacy')
  const unknown = join(f.home, 'sessions.trash-purge-staging', 'a-unknown')
  for (const path of [legacy, unknown]) {
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'session.v4.jsonl'), 'SYNTHETIC RESIDUE')
  }
  assert.deepEqual(await discoverSessionDirs(join(f.home, 'sessions')), [legacy, f.directory('a')],
    'positive control: dot projects are discoverable; sibling staging is excluded')
  await assert.rejects(f.trash.removeFromTrash('unknown'), /not in trash/)
  for (const path of [legacy, unknown]) assert.equal(await readFile(join(path, 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC RESIDUE')
  await unchanged(f)
})

await test('partial recursive deletion including lost lock is retryable', async f => {
  await f.create()
  const remove = f.trash.purger.removeDirectory.bind(f.trash.purger)
  f.trash.purger.removeDirectory = async path => {
    await rm(join(path, 'session.lock'))
    throw new Error('injected partial rm')
  }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[delete-staged\].*partial rm/)
  assert.equal(f.medium.get('a').purge.deleting, true)
  f.trash.purger.removeDirectory = remove
  assert.equal(await f.trash.removeFromTrash('a'), true)
})

for (const stage of ['detach', 'unarchive', 'marker']) {
  await test(`record cleanup ${stage} failure keeps discoverable marker across retry`, async f => {
    await f.create()
    f.hooks[stage] = () => { throw new Error(`injected ${stage}`) }
    await assert.rejects(f.trash.removeFromTrash('a'), new RegExp(`\\[${stage}\\]`))
    assert.equal(await exists(f.directory('a')), false)
    assert.equal(f.medium.get('a').purge.logsDeleted, true)
    assert.equal((await f.trash.listTrash())[0][1].purgePending, true)
    await assert.rejects(f.trash.restoreSession('a'), /cannot be restored/)
    delete f.hooks[stage]
    assert.equal(await f.trash.removeFromTrash('a'), true)
    assert.equal(f.medium.has('a'), false)
  })
}

await test('projection failure is a warning and does not reverse physical deletion', async f => {
  await f.create()
  f.trash.purger.clearProjection = async () => { throw new Error('cache unavailable') }
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.ok(f.logs.some(row => row.stage === 'projection' && row.result === 'warning'))
})

await test('empty reports partial success and retains busy marker for retry', async f => {
  await f.create('a'); await f.create('b')
  const lock = await acquireWriteLease(f.directory('a'))
  try { await assert.rejects(f.trash.emptyTrash(), /1 deleted, 1 failed.*busy/) }
  finally { await lock.release() }
  assert.equal(f.medium.has('a'), true); assert.equal(f.medium.has('b'), false)
  assert.equal(await f.trash.emptyTrash(), 1)
  assert.equal(await f.trash.emptyTrash(), 0)
})

await test('queued restore/retrash/empty cannot overtake a paused rename/delete', async f => {
  await f.create()
  const pause = barrier(), remove = f.trash.purger.removeDirectory.bind(f.trash.purger)
  f.trash.purger.removeDirectory = async path => { await pause.wait(); await remove(path) }
  const deletion = f.trash.removeFromTrash('a')
  await pause.arrived
  let restored = false, trashed = false
  const restore = f.trash.restoreSession('a').then(() => { restored = true })
  const retrash = f.trash.trashSession('a').then(() => { trashed = true })
  const empty = f.trash.emptyTrash()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(restored, false); assert.equal(trashed, false)
  // After purge, a real native registry refuses retrash of missing storage.
  f.hooks.archive = async id => { if (!(await exists(f.log(id)))) throw new Error('no stored session') }
  const rejected = assert.rejects(retrash, /no stored session/)
  pause.release()
  assert.equal(await deletion, true); await restore; await rejected
  assert.equal(await empty, 0)
  assert.equal(f.medium.size, 0); assert.equal(f.archived.has('a'), false)
})

await test('restore before purge and ordinary restore preserve logs and ownership', async f => {
  await f.create()
  const restore = f.trash.restoreSession('a')
  const rejection = assert.rejects(f.trash.removeFromTrash('a'), /not in trash/)
  await restore; await rejection
  assert.equal(f.medium.size, 0); assert.equal(f.archived.has('a'), false); assert.equal(f.members.has('a'), true)
  assert.equal(await exists(f.cache('a')), true)
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
})
console.log(`PASS: phase4 ${count} isolated filesystem scenarios, native lease/rename; ${skipped} explicitly skipped; no real sessions`)
