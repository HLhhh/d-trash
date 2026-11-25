import assert from 'node:assert/strict'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { setTimeout as sleep } from 'node:timers/promises'
import { fixture } from './phase4-fixture.mjs'
import { acquireWriteLease } from '../dist/write-lease.js'

let count = 0
const missing = file => assert.rejects(lstat(file), { code: 'ENOENT' })
const listen = f => {
  const ids = []
  f.ctx.on('api-session/removed', id => {
    assert.equal(f.medium.has(id), false, 'marker must already be committed away')
    assert.equal(f.archived.has(id), false)
    assert.equal(f.members.has(id), false)
    ids.push(id)
  })
  return ids
}
const test = async (name, run) => {
  const f = await fixture()
  try { await run(f); count++; console.log(`PASS: reappear ${name}`) }
  finally { await f.dispose() }
}
const until = async predicate => {
  const deadline = Date.now() + 6000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'startup completion timed out')
    await sleep(10)
  }
}

for (const ghost of [false, true]) {
  await test(`${ghost ? 'ghost' : 'physical'} completion emits once after marker and before projection`, async f => {
    const ids = listen(f)
    await f.create()
    if (ghost) await rm(f.directory('a'), { recursive: true })
    f.logs.length = 0
    f.ctx.on('api-session/removed', () => {
      assert.equal(f.logs.at(-1).stage, 'marker')
      assert.equal(f.logs.some(row => row.stage === 'projection'), false)
    })
    assert.equal(await f.trash.removeFromTrash('a'), true)
    await missing(f.directory('a'))
    assert.deepEqual(ids, ['a'])
    assert.deepEqual(f.logs.slice(-4).map(row => [row.stage, row.result]),
      [['marker', 'ok'], ['removed', 'ok'], ['projection', 'ok'], ['complete', 'ok']])
    await assert.rejects(f.trash.removeFromTrash('a'), /not in trash/)
    assert.deepEqual(ids, ['a'], 'a rejected repeat must not emit')
  })
}

for (const ghost of [false, true]) {
  for (const point of ['detach', 'unarchive', 'marker']) {
    await test(`${ghost ? 'ghost' : 'physical'} ${point} failure retains marker and never emits`, async f => {
      const ids = listen(f)
      await f.create()
      if (ghost) await rm(f.directory('a'), { recursive: true })
      f.hooks[point] = () => { throw new Error(`injected ${point}`) }
      await assert.rejects(f.trash.removeFromTrash('a'), new RegExp(`\\[${point}\\]`))
      assert.deepEqual(ids, [])
      assert.equal(f.medium.has('a'), true)
      assert.equal(f.logs.some(row => row.stage === 'removed'), false)
      delete f.hooks[point]
      // Ghost cleanup has no purge receipt; a committed unarchive requires re-trash before retry.
      if (ghost && point === 'marker') await f.trash.trashSession('a')
      assert.equal(await f.trash.removeFromTrash('a'), true)
      assert.deepEqual(ids, ['a'])
    })
  }
}

for (const ghost of [false, true]) {
  await test(`${ghost ? 'ghost' : 'physical'} throwing notification stays warning with successful deletion`, async f => {
    await f.create()
    if (ghost) await rm(f.directory('a'), { recursive: true })
    const error = new Error('removed listener failed')
    let attempts = 0
    f.ctx.on('api-session/removed', () => { attempts++; throw error })
    f.logs.length = 0
    assert.equal(await f.trash.removeFromTrash('a'), true)
    assert.equal(attempts, 1)
    assert.equal(f.medium.has('a'), false)
    await missing(f.directory('a'))
    assert.equal(f.logs.some(row => row.result === 'failed'), false)
    assert.deepEqual(f.logs.filter(row => row.stage === 'removed').map(row => [row.result, row.error]),
      [['warning', String(error)]])
    assert.equal(f.logs.at(-1).result, 'ok')
    const persisted = (await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(row => row.action === 'removeFromTrash')
    assert.ok(persisted.some(row => row.stage === 'removed' && row.result === 'warning' && /removed listener failed/.test(row.reason)))
    assert.equal(persisted.at(-1).result, 'ok')
  })
}

await test('gate, stat, intent and rm failures never emit; recovery alone never emits', async f => {
  const ids = listen(f)
  await f.create('a'); await f.create('b')
  f.archived.delete('a')
  await assert.rejects(f.trash.removeFromTrash('a'), /\[gate\]/)
  f.archived.add('a')
  f.hooks.stat = () => { throw new Error('stat failed') }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[gate\]/)
  delete f.hooks.stat
  f.hooks.put = (id, record) => { if (record.purge) throw new Error('intent failed') }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[intent\]/)
  delete f.hooks.put
  const remove = f.trash.purger.systemTrash.move.bind(f.trash.purger.systemTrash)
  f.trash.purger.systemTrash.move = async () => { throw new Error('rm failed') }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[moved-to-trash\]/)
  assert.deepEqual(ids, [])
  f.trash.purger.systemTrash.move = remove
  // Deleting b cancels a's unmoved intent; a keeps its marker and ownership.
  assert.equal(await f.trash.removeFromTrash('b'), true)
  assert.deepEqual(ids, ['b'])
  assert.equal(f.medium.get('a').purge, undefined)
  assert.equal(f.members.has('a'), true)
  assert.equal(await f.trash.removeFromTrash('a'), true)
  assert.deepEqual(ids, ['b', 'a'])
})

await test('queue and Restore cancellation never emit; startup emits only upon completion', async f => {
  const ids = listen(f)
  await f.create()
  const lease = await acquireWriteLease(f.directory('a'))
  try { await assert.rejects(f.trash.removeFromTrash('a'), /D_TRASH_DEFERRED/) }
  finally { await lease.release() }
  assert.deepEqual(ids, [])
  await f.trash.restoreSession('a') // queue cancellation
  await f.trash.restoreSession('a') // ordinary restore
  await f.trash.listTrash()
  assert.deepEqual(ids, [])
  await f.trash.trashSession('a')
  const busy = await acquireWriteLease(f.directory('a'))
  try { await assert.rejects(f.trash.removeFromTrash('a'), /D_TRASH_DEFERRED/) }
  finally { await busy.release() }
  f.trash[Service.init]()
  await until(() => f.logs.some(row => row.stage === 'complete' && row.result === 'ok' && !f.medium.has('a')))
  assert.deepEqual(ids, ['a'])
})

await test('mixed empty emits only physical and ghost successes, never queued/failed items', async f => {
  const ids = listen(f)
  for (const id of ['physical', 'ghost', 'busy', 'failed']) await f.create(id)
  await rm(f.directory('ghost'), { recursive: true })
  f.hooks.stat = id => { if (id === 'failed') throw new Error('stat failed') }
  const lease = await acquireWriteLease(f.directory('busy'))
  try {
    await assert.rejects(f.trash.emptyTrash(), /2 deleted, 1 failed, 1 queued/)
    assert.deepEqual(ids, ['physical', 'ghost'])
    assert.equal(f.medium.has('busy'), true); assert.equal(f.medium.has('failed'), true)
  } finally { await lease.release() }
})

await test('projection warning and event warning preserve empty success count', async f => {
  await f.create('a'); await f.create('b')
  const attempts = []
  f.ctx.on('api-session/removed', id => { attempts.push(id); throw new Error('notification failed') })
  f.trash.purger.clearProjection = async () => { throw new Error('projection failed') }
  assert.equal(await f.trash.emptyTrash(), 2)
  assert.deepEqual(attempts, ['a', 'b'])
  assert.equal(f.medium.size, 0)
  assert.equal(f.logs.filter(row => row.stage === 'removed' && row.result === 'warning').length, 2)
  assert.equal(f.logs.at(-1).result, 'ok')
})

console.log(`PASS: reappear regressions ${count} passed, 0 skipped (synthetic homes only)`)
