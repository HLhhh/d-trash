import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { StorageError } from '@deepseek-ai/dsh-storage'
import { readFileSync } from 'node:fs'
import legacyPurgeSeam from './legacy-purge-seam.cjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { default: TrashService } = await import(manifest.name)

const tick = () => new Promise(resolve => setImmediate(resolve))
const pendingBarriers = new Set()
function barrier() {
  let arrive, resolveGate
  const entered = new Promise(resolve => { arrive = resolve })
  const gate = new Promise(resolve => { resolveGate = resolve })
  const release = () => { pendingBarriers.delete(release); resolveGate() }
  pendingBarriers.add(release)
  return { entered, release, async wait() { arrive(); await gate } }
}

// Real DomainFacility queues and caches over an isolated, durable-map medium.
// Hooks fail before writes, after commits, or suspend at explicit barriers.
function fixture() {
  const ctx = new Context()
  const medium = new Map()
  const archived = new Set()
  const hooks = {}
  const calls = []
  let opens = 0, closes = 0
  const backend = { kv: { async open() {
    opens++
    await hooks.open?.()
    return {
      async loadAll() { return { global: null, tables: { trash: Object.fromEntries(medium) } } },
      async putRecord(table, id, record) {
        calls.push(`put:${id}`)
        await hooks.put?.(id)
        medium.set(id, structuredClone(record))
      },
      async deleteRecord(table, id) {
        calls.push(`delete:${id}`)
        await hooks.delete?.(id)
        medium.delete(id)
      },
      async deleteRecords(table, ids) {
        calls.push('empty')
        await hooks.empty?.(ids)
        ids.forEach(id => medium.delete(id))
      },
      async close() { closes++; await hooks.close?.() },
    }
  } } }
  ctx.provide('storage', { backend: { get: () => backend } })
  const facility = new DomainFacility(ctx, { backend: 'test' })
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    get archivedSessionIds() { return [...archived] },
    async archiveSession(id, options) {
      assert.equal(options.stopActivity, true)
      calls.push(`archive:${id}`)
      await hooks.archive?.(id)
      archived.add(id)
      await hooks.afterArchive?.(id)
    },
    async unarchiveSession(id) {
      calls.push(`unarchive:${id}`)
      await hooks.unarchive?.(id)
      archived.delete(id)
      await hooks.afterUnarchive?.(id)
    },
  })
  const trash = new TrashService(ctx)
  legacyPurgeSeam(trash)
  return { ctx, medium, archived, hooks, calls, facility, trash,
    get opens() { return opens }, get closes() { return closes },
    async check(id, isArchived, isTrashed) {
      assert.equal(archived.has(id), isArchived, 'archive state')
      assert.equal(medium.has(id), isTrashed, 'durable marker state')
      const snapshot = new Map(await trash.listTrash())
      assert.equal(snapshot.has(id), isTrashed, 'domain cache must match medium')
      for (const [key, record] of medium) assert.ok(record.purge || archived.has(key), `invariant: ${key} must be archived`)
    },
    dispose: () => ctx.fiber.dispose(),
  }
}

async function test(name, run) {
  const f = fixture()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 5000)
  })
  try { await Promise.race([run(f), timeout]); console.log(`PASS: ${name}`) }
  finally {
    clearTimeout(timer)
    for (const release of pendingBarriers) release()
    await f.dispose()
  }
}
const fail = message => () => { throw new Error(message) }
const aggregate = (...messages) => error => {
  assert.ok(error instanceof AggregateError)
  assert.deepEqual(error.errors.map(item => item.message), messages)
  assert.equal(error.cause, error.errors[0])
  return true
}

await test('unarchive: native command removes stale durable markers on list, preserving archives and metadata', async f => {
  await f.trash.trashSession('native')
  await f.trash.trashSession('retained')
  f.archived.add('archive-only')
  const retained = structuredClone(f.medium.get('retained'))
  await f.ctx.get('workspaceRegistry').unarchiveSession('native')
  assert.equal(f.medium.has('native'), true, 'native command cannot write plugin storage')
  assert.deepEqual(await f.trash.listTrash(), [['retained', retained]])
  assert.equal(f.medium.has('native'), false, 'list must await durable deleteMany')
  await f.check('native', false, false)
  await f.check('retained', true, true)
  await f.check('archive-only', true, false)
  f.archived.add('native')
  assert.equal(new Map(await f.trash.listTrash()).has('native'), false, 'later native archive must not recreate trash')
})

await test('unarchive: persisted stale markers are reconciled on first list without prior plugin calls', async f => {
  f.medium.set('offline-unarchive', { trashedAt: 1 })
  f.medium.set('still-archived', { trashedAt: 2, titleSnapshot: 'Saved', workspaceId: 'workspace' })
  f.archived.add('still-archived')
  assert.deepEqual(await f.trash.listTrash(), [['still-archived', f.medium.get('still-archived')]])
  assert.equal(f.medium.has('offline-unarchive'), false)
})

await test('unarchive: restoreSession still unarchives and deletes its marker, including an already unarchived id', async f => {
  await f.trash.trashSession('restore')
  await f.trash.restoreSession('restore')
  await f.check('restore', false, false)
  await f.trash.trashSession('external')
  await f.ctx.get('workspaceRegistry').unarchiveSession('external')
  await f.trash.restoreSession('external')
  await f.check('external', false, false)
})

await test('unarchive: cleanup fences a later re-trash so it cannot delete the new marker', async f => {
  await f.trash.trashSession('a')
  f.archived.delete('a')
  const pause = barrier()
  f.hooks.empty = () => pause.wait()
  const list = f.trash.listTrash()
  await pause.entered
  const move = f.trash.trashSession('a')
  const calls = f.calls.length
  await tick()
  assert.equal(f.calls.length, calls)
  pause.release()
  assert.deepEqual(await list, [])
  await move
  await f.check('a', true, true)
})

await test('unarchive: another native unarchive during cleanup is reconciled before returning', async f => {
  await f.trash.trashSession('a')
  await f.trash.trashSession('b')
  f.archived.delete('a')
  const pause = barrier()
  f.hooks.empty = () => pause.wait()
  const list = f.trash.listTrash()
  await pause.entered
  await f.ctx.get('workspaceRegistry').unarchiveSession('b')
  pause.release()
  assert.deepEqual(await list, [])
  assert.equal(f.medium.size, 0)
})

await test('unarchive: cleanup persistence failure surfaces and a later list retries safely', async f => {
  await f.trash.trashSession('a')
  f.archived.delete('a')
  f.hooks.empty = fail('cleanup failed')
  await assert.rejects(f.trash.listTrash(), /cleanup failed/)
  assert.equal(f.medium.has('a'), true)
  delete f.hooks.empty
  assert.deepEqual(await f.trash.listTrash(), [])
  assert.equal(f.medium.has('a'), false)
})

await test('B1 archive pre-commit failure never writes a marker; retry succeeds', async f => {
  f.hooks.archive = fail('archive before commit')
  await assert.rejects(f.trash.trashSession('a'), /archive before commit/)
  await f.check('a', false, false)
  assert.deepEqual(f.calls, ['archive:a'])
  delete f.hooks.archive
  await f.trash.trashSession('a')
  await f.check('a', true, true)
})

await test('B1 stopActivity failure after archive commit retains safe native archive', async f => {
  f.hooks.afterArchive = fail('stopActivity')
  await assert.rejects(f.trash.trashSession('a'), /stopActivity/)
  await f.check('a', true, false)
  assert.deepEqual(f.calls, ['archive:a'])
})

await test('B1 marker put failure compensates a new archive', async f => {
  f.hooks.put = fail('put failed')
  await assert.rejects(f.trash.trashSession('a'), /put failed/)
  await f.check('a', false, false)
  assert.deepEqual(f.calls, ['archive:a', 'put:a', 'unarchive:a'])
})

await test('B1 failed put leaves an existing native archive untouched', async f => {
  f.archived.add('a')
  f.hooks.put = fail('put failed')
  await assert.rejects(f.trash.trashSession('a'), /put failed/)
  await f.check('a', true, false)
  assert.ok(!f.calls.includes('unarchive:a'))
})

await test('B1 failed replacement retains an existing marker and its metadata', async f => {
  await f.trash.trashSession('a')
  const original = structuredClone(f.medium.get('a'))
  f.hooks.put = fail('put failed')
  await assert.rejects(f.trash.trashSession('a'), /put failed/)
  await f.check('a', true, true)
  assert.deepEqual(f.medium.get('a'), original)
})

for (const afterCommit of [false, true]) {
  await test(`B1 archive rollback failure (${afterCommit ? 'after' : 'before'} commit) remains safe`, async f => {
    f.hooks.put = fail('put failed')
    f.hooks[afterCommit ? 'afterUnarchive' : 'unarchive'] = fail('rollback failed')
    await assert.rejects(f.trash.trashSession('a'), aggregate('put failed', 'rollback failed'))
    await f.check('a', !afterCommit, false)
  })
}

await test('B1 delete marker failure never unarchives', async f => {
  await f.trash.trashSession('a')
  f.hooks.delete = fail('delete failed')
  await assert.rejects(f.trash.restoreSession('a'), /delete failed/)
  await f.check('a', true, true)
  assert.ok(!f.calls.includes('unarchive:a'))
})

await test('B1 unarchive pre-commit failure restores exact marker', async f => {
  await f.trash.trashSession('a')
  const original = structuredClone(f.medium.get('a'))
  f.hooks.unarchive = fail('unarchive failed')
  await assert.rejects(f.trash.restoreSession('a'), /unarchive failed/)
  await f.check('a', true, true)
  assert.deepEqual(f.medium.get('a'), original)
})

await test('B1 unarchive post-commit failure must not restore a marker', async f => {
  await f.trash.trashSession('a')
  f.hooks.afterUnarchive = fail('unarchive follow-up failed')
  await assert.rejects(f.trash.restoreSession('a'), /unarchive follow-up failed/)
  await f.check('a', false, false)
})

await test('B1 restore compensation failure retains archive without marker', async f => {
  await f.trash.trashSession('a')
  f.hooks.unarchive = fail('unarchive failed')
  f.hooks.put = fail('restore marker failed')
  await assert.rejects(f.trash.restoreSession('a'), aggregate('unarchive failed', 'restore marker failed'))
  await f.check('a', true, false)
})

await test('B1 uncertain marker write quarantines domain without unsafe unarchive', async f => {
  f.hooks.put = id => {
    f.medium.set(id, { trashedAt: 1 })
    throw new StorageError('unknown-state', 'uncertain commit')
  }
  await assert.rejects(f.trash.trashSession('a'), aggregate('uncertain commit', 'uncertain commit'))
  assert.equal(f.archived.has('a'), true)
  assert.equal(f.medium.has('a'), true)
  assert.ok(!f.calls.includes('unarchive:a'))
  await assert.rejects(f.trash.listTrash(), /uncertain commit/)
})

await test('B1 uncertain marker deletion never unarchives, even if deletion committed', async f => {
  await f.trash.trashSession('a')
  f.hooks.delete = id => {
    f.medium.delete(id)
    throw new StorageError('unknown-state', 'uncertain delete')
  }
  await assert.rejects(f.trash.restoreSession('a'), /uncertain delete/)
  assert.equal(f.archived.has('a'), true)
  assert.equal(f.medium.has('a'), false)
  assert.ok(!f.calls.includes('unarchive:a'))
  await assert.rejects(f.trash.listTrash(), /uncertain delete/)
})

await test('B2 restore then trash cannot interleave across the unarchive boundary', async f => {
  await f.trash.trashSession('a')
  const pause = barrier()
  f.hooks.afterUnarchive = () => pause.wait()
  const restore = f.trash.restoreSession('a')
  await pause.entered
  const before = f.calls.length
  const move = f.trash.trashSession('a')
  await tick()
  assert.equal(f.calls.length, before, 'same-session trash must wait for complete restore')
  pause.release()
  await Promise.all([restore, move])
  await f.check('a', true, true)
})

await test('B2 trash then restore serializes the entire archive/marker operation', async f => {
  const pause = barrier()
  f.hooks.afterArchive = () => pause.wait()
  const move = f.trash.trashSession('a')
  await pause.entered
  const restore = f.trash.restoreSession('a')
  await tick()
  assert.deepEqual(f.calls, ['archive:a'])
  pause.release()
  await Promise.all([move, restore])
  await f.check('a', false, false)
})

await test('B2 purge fences earlier trash and later sessions', async f => {
  const pause = barrier()
  f.hooks.afterArchive = id => id === 'a' ? pause.wait() : undefined
  const move = f.trash.trashSession('a')
  await pause.entered
  const remove = f.trash.removeFromTrash('a')
  const moveB = f.trash.trashSession('b')
  await tick()
  assert.ok(!f.calls.includes('archive:b'))
  assert.ok(!f.calls.includes('delete:a'))
  pause.release()
  await move
  assert.equal(await remove, true)
  await moveB
  await f.check('a', false, false)
  await f.check('b', true, true)
})

await test('B2 compensation stays locked and a rejected operation releases its queue', async f => {
  const pause = barrier()
  f.hooks.put = fail('put failed')
  f.hooks.unarchive = () => pause.wait()
  const failed = assert.rejects(f.trash.trashSession('a'), /put failed/)
  await pause.entered
  const before = f.calls.length
  const move = f.trash.trashSession('a')
  await tick()
  assert.equal(f.calls.length, before)
  delete f.hooks.put
  pause.release()
  await Promise.all([failed, move])
  await f.check('a', true, true)
})

await test('B2 empty fences earlier operations and blocks later operations across sessions', async f => {
  const first = barrier(), empty = barrier()
  f.hooks.afterArchive = id => id === 'a' ? first.wait() : undefined
  f.hooks.delete = () => empty.wait()
  const moveA = f.trash.trashSession('a')
  await first.entered
  const clear = f.trash.emptyTrash()
  const moveB = f.trash.trashSession('b')
  let listed = false
  const list = f.trash.listTrash().then(value => { listed = true; return value })
  await tick()
  assert.deepEqual(f.calls, ['archive:a'])
  first.release()
  await empty.entered
  assert.ok(f.medium.has('a'))
  assert.ok(!f.calls.includes('archive:b'))
  assert.equal(listed, false)
  empty.release()
  await moveA
  assert.equal(await clear, 1)
  await moveB
  assert.deepEqual((await list).map(([id]) => id), ['b'])
  await f.check('a', false, false)
  await f.check('b', true, true)
})

await test('B2 failed empty retains markers and releases the global boundary', async f => {
  await f.trash.trashSession('a')
  f.hooks.delete = fail('marker failed')
  const clear = assert.rejects(f.trash.emptyTrash(), /marker failed/)
  const move = f.trash.trashSession('b')
  await Promise.all([clear, move])
  await f.check('a', false, true)
  await f.check('b', true, true)
})

await test('M2 concurrent first opens share failure, then retry succeeds and is shared', async f => {
  const pause = barrier()
  f.hooks.open = async () => { await pause.wait(); throw new Error('open failed') }
  const first = f.trash.listTrash(), second = f.trash.listTrash()
  const rejected = Promise.all([assert.rejects(first, /open failed/), assert.rejects(second, /open failed/)])
  await pause.entered
  assert.equal(f.opens, 1)
  pause.release()
  await rejected
  delete f.hooks.open
  await Promise.all([f.trash.listTrash(), f.trash.listTrash(), f.trash.trashSession('a')])
  assert.equal(f.opens, 2)
  await f.check('a', true, true)
  await f.dispose()
  assert.equal(f.closes, 1)
})

await test('M2 disposal after failed open never attempts to close a missing handle', async f => {
  f.hooks.open = fail('open failed')
  await assert.rejects(f.trash.listTrash(), /open failed/)
  await f.dispose()
  assert.equal(f.opens, 1)
  assert.equal(f.closes, 0)
})

await test('M2 disposal waits for a pending successful open and closes once', async f => {
  const pause = barrier()
  f.hooks.open = () => pause.wait()
  const list = f.trash.listTrash()
  await pause.entered
  const disposal = f.dispose()
  await tick()
  assert.equal(f.closes, 0)
  pause.release()
  await list
  await disposal
  assert.equal(f.closes, 1)
})
