import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './phase4-fixture.mjs'
import { NativeSystemTrash, requireSameDevice } from '../dist/system-trash.js'
import { acquireWriteLease } from '../dist/write-lease.js'

let passed = 0
async function test(name, run) {
  const f = await fixture()
  try { await run(f); passed++; console.log(`PASS: system-trash ${name}`) }
  finally { await f.dispose() }
}
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' })
const legacy = async (f, { moved = true, deleting = false, logsDeleted = false } = {}) => {
  const source = f.directory('a'), identity = await lstat(source, { bigint: true })
  const staging = join(f.home, 'sessions.trash-purge-staging')
  await mkdir(staging, { recursive: true })
  const target = join(staging, 'a-legacy')
  if (moved) await rename(source, target)
  const intent = { source, target, dev: String(identity.dev), ino: String(identity.ino), deleting, logsDeleted }
  const table = (await f.trash.domain()).table('trash')
  await table.put('a', { ...table.get('a'), purge: intent })
  return { target, table }
}

await test('source-only intent retains complete log generations and emits current audit stages', async f => {
  await f.create()
  let receipt
  f.hooks.put = (_, record) => { if (record.purge) receipt = structuredClone(record.purge) }
  await f.trash.removeFromTrash('a')
  assert.deepEqual(Object.keys(receipt).sort(), ['dev', 'ino', 'moving', 'source'])
  assert.equal(receipt.moving, true)
  const [name] = await readdir(f.systemTrash)
  assert.equal(await readFile(join(f.systemTrash, name, 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  assert.equal(await readFile(join(f.systemTrash, name, 'session.v3.jsonl.zstd'), 'utf8'), 'SYNTHETIC OLDER GENERATION')
  await absent(f.directory('a')); await absent(f.cache('a'))
  assert.equal(f.medium.size, 0); assert.equal(f.members.size, 0); assert.equal(f.archived.size, 0)
  assert.equal(f.logs.filter(row => row.stage === 'moved-to-trash' && row.result === 'ok').length, 1)
  assert.equal(f.logs.some(row => ['renamed', 'logs-deleted', 'delete-staged'].includes(row.stage)), false)
})

await test('failed move preserves source and receipt, then retries through the full gate', async f => {
  await f.create()
  f.hooks.move = () => { throw new Error('injected trash failure') }
  await assert.rejects(f.trash.removeFromTrash('a'), /injected trash failure/)
  assert.equal(f.medium.get('a').purge.moving, true)
  assert.ok(f.archived.has('a')); assert.ok(f.members.has('a'))
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  await f.trash.listTrash()
  await assert.rejects(f.trash.restoreSession('a'), /cannot be restored/)
  await assert.rejects(f.trash.trashSession('a'), /pending/)
  delete f.hooks.move
  await f.trash.removeFromTrash('a')
  assert.equal((await readdir(f.systemTrash)).length, 1)
})

for (const moved of [false, true]) await test(`restart after ${moved ? 'move before acknowledgement' : 'intent before move'} uses source presence`, async f => {
  await f.create()
  const original = f.trash.purger.systemTrash.move.bind(f.trash.purger.systemTrash)
  f.trash.purger.systemTrash.move = async (...args) => {
    if (moved) await original(...args)
    throw new Error('simulated process interruption')
  }
  await assert.rejects(f.trash.removeFromTrash('a'), /interruption/)
  assert.equal(f.logs.some(row => row.stage === 'moved-to-trash' && row.result === 'ok'), false)
  const restarted = await fixture(f.home)
  try {
    let moves = 0
    restarted.hooks.move = () => { moves++ }
    if (moved) restarted.hooks.stat = () => { throw new Error('stat unavailable after move') }
    assert.equal(await restarted.trash.removeFromTrash('a'), true)
    assert.equal(moves, moved ? 0 : 1)
    assert.equal((await readdir(f.systemTrash)).length, 1)
    assert.equal(restarted.medium.size, 0)
  } finally { await restarted.dispose(true) }
})

await test('source replacement after interrupted intent is retained for diagnosis', async f => {
  await f.create()
  f.hooks.move = () => { throw new Error('interruption') }
  await assert.rejects(f.trash.removeFromTrash('a'), /interruption/)
  await rename(f.directory('a'), join(f.home, 'original'))
  await mkdir(f.directory('a'))
  await writeFile(f.log('a'), 'REPLACEMENT')
  delete f.hooks.move
  await assert.rejects(f.trash.removeFromTrash('a'), /replaced/)
  assert.ok(f.medium.get('a').purge)
  assert.equal(await readFile(f.log('a'), 'utf8'), 'REPLACEMENT')
})

await test('adapter claiming success while source exists cannot clear records', async f => {
  await f.create()
  f.trash.purger.systemTrash.move = async (_, __, recheck) => { await recheck() }
  await assert.rejects(f.trash.removeFromTrash('a'), /did not remove the source/)
  assert.ok(f.medium.get('a').purge); assert.ok(f.archived.has('a')); assert.ok(f.members.has('a'))
})

for (const moved of [false, true]) await test(`legacy receipt ${moved ? 'in staging moves remaining directory' : 'not migrated rolls back and moves source'}`, async f => {
  await f.create()
  const { target } = await legacy(f, { moved })
  assert.equal(await f.trash.removeFromTrash('a'), true)
  await absent(target)
  assert.equal((await readdir(f.systemTrash)).length, 1)
})

await test('legacy moving receipt survives move-before-acknowledgement failure', async f => {
  await f.create()
  const { target } = await legacy(f)
  const original = f.trash.purger.systemTrash.move.bind(f.trash.purger.systemTrash)
  f.trash.purger.systemTrash.move = async (...args) => { await original(...args); throw new Error('lost acknowledgement') }
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.ok(f.logs.some(row => row.stage === 'recovery' && row.result === 'failed'))
  await absent(target)
  assert.equal((await readdir(f.systemTrash)).length, 1)
})

await test('legacy completed-rm receipt cleans records without touching system trash', async f => {
  await f.create()
  const { target } = await legacy(f, { deleting: true, logsDeleted: true })
  await rm(target, { recursive: true }) // simulate a pre-5.2 completed deletion, temporary fixture only
  f.hooks.move = () => assert.fail('must not move absent legacy payload')
  assert.equal(await f.trash.removeFromTrash('a'), true)
})

await test('cross-volume refusal retains source and receipt; never copies', async f => {
  await f.create()
  f.hooks.move = async source => requireSameDevice(await lstat(source, { bigint: true }), { dev: -1n })
  await assert.rejects(f.trash.removeFromTrash('a'), /another volume/)
  assert.ok(f.medium.get('a').purge)
  assert.equal((await readdir(f.systemTrash)).length, 0)
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
})

await test('unsupported platform rejects without calling the mutation gate', async f => {
  await f.create()
  const native = new NativeSystemTrash('linux')
  await assert.rejects(native.move(f.directory('a'), await lstat(f.directory('a'), { bigint: true }),
    () => assert.fail('no native mutation on unsupported platform')), /unsupported on linux/)
})

await test('empty summarizes moved, failed and lock-busy queued items independently', async f => {
  for (const id of ['ok', 'fail', 'busy']) await f.create(id)
  const lock = await acquireWriteLease(f.directory('busy'))
  f.hooks.move = source => { if (source === f.directory('fail')) throw new Error('trash unavailable') }
  try { await assert.rejects(f.trash.emptyTrash(), /1 deleted, 1 failed, 1 queued/) }
  finally { await lock.release() }
  assert.equal(f.medium.has('ok'), false)
  assert.ok(f.medium.get('fail').purge)
  assert.ok(f.medium.get('busy').deferredAt)
  delete f.hooks.move
  assert.equal(await f.trash.emptyTrash(), 2)
  assert.equal((await readdir(f.systemTrash)).length, 3)
})

if (process.platform === 'darwin') await test('macOS native exclusive rename uses only injected temporary user home', async f => {
  await f.create()
  // Exercises renamex_np ABI in a temporary .Trash, never the real ~/.Trash.
  const home = join(f.home, 'synthetic-user')
  await mkdir(home)
  f.trash.purger.systemTrash = new NativeSystemTrash('darwin', () => home)
  await f.trash.removeFromTrash('a')
  const [name] = await readdir(join(home, '.Trash'))
  assert.match(name, /^d-trash-/)
  assert.equal(await readFile(join(home, '.Trash', name, 'session.v4.jsonl'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
})
else console.log('SKIP: system-trash macOS native exclusive rename (requires macOS; Windows Shell requires manual acceptance)')
console.log(`PASS: system-trash ${passed} scenarios; real system trash untouched`)
