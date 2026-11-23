import assert from 'node:assert/strict'
import { Service } from '@deepseek-ai/cordis'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fixture } from './phase4-fixture.mjs'
import { acquireWriteLease } from '../dist/write-lease.js'
import { DEFERRED_PREFIX } from '../dist/types.js'

let count = 0
const rows = async f => JSON.parse('[' + (await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')).trim().split('\n').join(',') + ']')
const until = async predicate => {
  const deadline = Date.now() + 6000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'background startup timed out')
    await sleep(10)
  }
}
const queued = error => { assert.ok(error.message.startsWith(DEFERRED_PREFIX), error.message); return true }
const queue = async (f, id = 'a') => {
  const lease = await acquireWriteLease(f.directory(id))
  try { await assert.rejects(f.trash.removeFromTrash(id), queued) }
  finally { await lease.release() }
}
const test = async (name, job) => {
  const f = await fixture()
  try { await job(f); count++; console.log(`PASS: deferred ${name}`) }
  finally { await f.dispose() }
}

await test('lock busy persists a private queue timestamp, preserves data and lock inode, exposes only deferred', async f => {
  await f.create()
  const before = await lstat(join(f.directory('a'), 'session.lock'), { bigint: true })
  await queue(f)
  const first = f.medium.get('a').deferredAt
  assert.equal(typeof first, 'number')
  await queue(f)
  assert.equal(f.medium.get('a').deferredAt, first)
  assert.equal(f.medium.get('a').purge, undefined)
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  assert.equal(f.archived.has('a'), true); assert.equal(f.members.has('a'), true)
  const after = await lstat(join(f.directory('a'), 'session.lock'), { bigint: true })
  assert.equal(after.ino, before.ino)
  const visible = (await f.trash.listTrash())[0][1]
  assert.equal(visible.deferred, true); assert.equal(visible.deferredAt, undefined); assert.equal(visible.purgePending, undefined)
  const log = await rows(f)
  assert.ok(log.some(row => row.stage === 'deferred' && row.result === 'ok' && /busy/.test(row.reason)))
  assert.ok(!log.some(row => row.stage === 'locked' || row.stage === 'unlocked' || row.stage === 'intent'))
})

await test('a new Cordis plugin Host automatically purges queued sessions and clears all required records/cache', async f => {
  await f.create(); await queue(f); await f.dispose(true)
  const restarted = await fixture(f.home, { start: true })
  try {
    await until(() => restarted.logs.some(row => row.stage === 'complete' && row.result === 'ok'))
    assert.equal(restarted.medium.size, 0)
    assert.equal(restarted.archived.size, 0); assert.equal(restarted.members.size, 0)
    await assert.rejects(lstat(restarted.directory('a')), { code: 'ENOENT' })
    await assert.rejects(lstat(restarted.cache('a')), { code: 'ENOENT' })
    assert.ok((await rows(restarted)).some(row => row.action === 'startup' && row.sessionId === 'a' && row.stage === 'complete' && row.result === 'ok'))
  } finally { await restarted.dispose(true) }
})

await test('restart still busy retains queue without ownership/unlock claims, while another item completes', async f => {
  await f.create('a'); await f.create('b'); await queue(f, 'a'); await queue(f, 'b'); await f.dispose(true)
  const lease = await acquireWriteLease(f.directory('a'))
  const restarted = await fixture(f.home, { start: true })
  try {
    await until(() => !restarted.medium.has('b'))
    assert.equal(typeof restarted.medium.get('a').deferredAt, 'number')
    assert.equal(restarted.medium.get('a').purge, undefined)
    assert.equal(await readFile(restarted.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
    const log = (await rows(restarted)).filter(row => row.action === 'startup' && row.sessionId === 'a')
    assert.ok(log.some(row => row.stage === 'complete' && row.result === 'deferred'))
    assert.ok(!log.some(row => row.stage === 'locked' || row.stage === 'unlocked'))
  } finally { await lease.release(); await restarted.dispose(true) }
})

await test('Restore cancels only the queue, keeps archive/membership/logs, and survives restart', async f => {
  await f.create(); await queue(f)
  await f.trash.restoreSession('a')
  assert.equal(f.medium.get('a').deferredAt, undefined)
  assert.equal(f.archived.has('a'), true); assert.equal(f.members.has('a'), true)
  assert.equal((await f.trash.listTrash())[0][1].deferred, undefined)
  await f.dispose(true)
  const restarted = await fixture(f.home, { start: true })
  try {
    await restarted.trash.listTrash(); await sleep(40)
    assert.equal(restarted.medium.has('a'), true)
    assert.equal(await readFile(restarted.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
    await restarted.trash.restoreSession('a') // ordinary Restore still unarchives
    assert.equal(restarted.archived.has('a'), false)
  } finally { await restarted.dispose(true) }
})

await test('gate/stat and detach EBUSY failures do not create a queue; started deletion keeps its receipt', async f => {
  await f.create()
  f.hooks.stat = () => { throw Object.assign(new Error('stat EBUSY'), { code: 'EBUSY' }) }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[gate\]/)
  assert.equal(f.medium.get('a').deferredAt, undefined)
  delete f.hooks.stat
  f.hooks.detach = () => { throw Object.assign(new Error('detach EBUSY'), { code: 'EBUSY' }) }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[detach\]/)
  assert.equal(f.medium.get('a').deferredAt, undefined)
  assert.equal(f.medium.get('a').purge.logsDeleted, true)
})

await test('manual retry removes deferredAt before durable intent; receipt failure retains recovery protocol', async f => {
  await f.create(); await queue(f)
  f.hooks.put = (id, record) => { if (record.purge) assert.equal(record.deferredAt, undefined) }
  f.hooks.detach = () => { throw new Error('detach denied') }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[detach\]/)
  assert.equal(f.medium.get('a').deferredAt, undefined)
  assert.ok(f.medium.get('a').purge)
  await assert.rejects(f.trash.restoreSession('a'), /cannot be restored/)
  delete f.hooks.detach
  assert.equal(await f.trash.removeFromTrash('a'), true)
})

await test('startup ignores existing purge receipts, including conflicting legacy fields, and manual recovery still works', async f => {
  await f.create()
  f.hooks.detach = () => { throw new Error('detach denied') }
  await assert.rejects(f.trash.removeFromTrash('a'), /detach denied/)
  const receipt = structuredClone(f.medium.get('a').purge)
  await f.dispose(true)
  const markers = JSON.parse(await readFile(join(f.home, 'markers.json'), 'utf8'))
  markers.a.deferredAt = Date.now()
  await writeFile(join(f.home, 'markers.json'), JSON.stringify(markers))
  const restarted = await fixture(f.home, { start: true })
  try {
    await restarted.trash.listTrash(); await sleep(40)
    assert.deepEqual(restarted.medium.get('a').purge, receipt)
    const record = (await restarted.trash.listTrash())[0][1]
    assert.equal(record.purgePending, true); assert.equal(record.deferred, undefined)
    await assert.rejects(restarted.trash.restoreSession('a'), /cannot be restored/)
    assert.equal(await restarted.trash.removeFromTrash('a'), true)
  } finally { await restarted.dispose(true) }
})

await test('empty separates deleted, queued and true failures, including queue-only acknowledgement', async f => {
  for (const id of ['a', 'b', 'c']) await f.create(id)
  const lease = await acquireWriteLease(f.directory('a'))
  f.hooks.detach = id => { if (id === 'c') throw new Error('c detach denied') }
  try {
    await assert.rejects(f.trash.emptyTrash(), error => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /1 deleted, 1 failed, 1 queued/)
      assert.ok(!error.message.startsWith(DEFERRED_PREFIX))
      assert.equal(error.errors.length, 1); assert.match(String(error.errors[0]), /\[detach\]/)
      return true
    })
    assert.equal(typeof f.medium.get('a').deferredAt, 'number')
    assert.equal(f.medium.get('c').deferredAt, undefined)
    delete f.hooks.detach
    await assert.rejects(f.trash.emptyTrash(), error => { queued(error); assert.match(error.message, /1 deleted, 0 failed, 1 queued/); return true })
    assert.equal((await rows(f)).at(-1).result, 'deferred')
  } finally { await lease.release() }
  assert.equal(await f.trash.emptyTrash(), 1)
})

await test('queue persistence failure is a real deferred-stage failure without a false acknowledgement', async f => {
  await f.create()
  f.hooks.put = (id, record) => { if (record.deferredAt !== undefined) throw new Error('queue write denied') }
  const lease = await acquireWriteLease(f.directory('a'))
  try {
    await assert.rejects(f.trash.removeFromTrash('a'), error => {
      assert.ok(!error.message.startsWith(DEFERRED_PREFIX)); assert.match(error.message, /\[deferred\].*queue write denied/); return true
    })
    assert.equal(f.medium.get('a').deferredAt, undefined)
  } finally { await lease.release() }
})

await test('startup retries service-not-ready stat failures later', async f => {
  await f.create(); await queue(f); await f.dispose(true)
  const restarted = await fixture(f.home, { start: true })
  try {
    let ready = false
    restarted.hooks.stat = () => { if (!ready) throw new Error('persistence warming up') }
    await until(() => restarted.logs.some(row => row.stage === 'complete' && row.result === 'failed'))
    assert.ok(restarted.medium.has('a'))
    ready = true
    await until(() => restarted.logs.some(row => row.stage === 'complete' && row.result === 'ok'))
    assert.equal(restarted.medium.size, 0)
  } finally { await restarted.dispose(true) }
})

await test('initialization does not await a suspended purge and disposal joins admitted maintenance', async f => {
  await f.create(); await queue(f); await f.dispose(true)
  const restarted = await fixture(f.home)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered = false
  restarted.hooks.stat = async () => { entered = true; await gate }
  try {
    assert.equal(restarted.trash[Service.init](), undefined)
    await until(() => entered)
    assert.ok(restarted.medium.has('a'))
    let disposed = false
    const disposing = restarted.ctx.fiber.dispose().then(() => { disposed = true })
    await sleep(20)
    assert.equal(disposed, false)
    release()
    await disposing
    // This fixture disposes dependency providers with the root; a withdrawn
    // registry must conservatively leave the queue, never force completion.
    assert.equal(typeof restarted.medium.get('a').deferredAt, 'number')
    assert.equal(restarted.medium.get('a').purge, undefined)
    assert.equal(await readFile(restarted.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  } finally { release(); await restarted.dispose(true) }
})

await test('domain open failures are best effort and retried without blocking initialization', async f => {
  await f.create(); await queue(f); await f.dispose(true)
  const restarted = await fixture(f.home)
  try {
    const facility = restarted.ctx.get('storageDomain'), open = facility.open.bind(facility)
    let attempts = 0
    facility.open = (...args) => { if (++attempts === 1) throw new Error('domain not ready'); return open(...args) }
    assert.equal(restarted.trash[Service.init](), undefined)
    await until(() => restarted.medium.size === 0)
    assert.ok(attempts >= 2)
    assert.ok((await rows(restarted)).some(row => row.action === 'startup' && row.stage === 'scan' && row.result === 'failed'))
  } finally { await restarted.dispose(true) }
})

await test('disposal cancels scheduled retries and native unarchive keeps the ordinary intersection gate', async f => {
  await f.create(); await queue(f)
  f.archived.delete('a')
  assert.equal(f.trash[Service.init](), undefined)
  await until(() => f.logs.some(row => row.stage === 'complete' && row.result === 'failed'))
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  await f.trash.listTrash()
  assert.equal(f.medium.size, 0)
  await f.dispose(true)
  const count = f.logs.length
  await sleep(1100)
  assert.equal(f.logs.length, count)
})

console.log(`PASS: deferred ${count} synthetic-home scenarios; no real sessions or profile changes`)
