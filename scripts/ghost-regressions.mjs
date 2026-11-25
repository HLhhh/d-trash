import assert from 'node:assert/strict'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './phase4-fixture.mjs'

const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' })
const rows = async f => (await readFile(join(f.home, 'logs', 'trash.log'), 'utf8')).trimEnd().split('\n').map(JSON.parse)
const clean = async f => {
  assert.equal(f.medium.has('a'), false)
  assert.equal(f.archived.has('a'), false)
  assert.equal(f.members.has('a'), false)
  await absent(f.directory('a'))
  await absent(f.cache('a'))
  assert.deepEqual(await f.trash.listTrash(), [])
}
const untouched = async (f, marker) => {
  assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  assert.equal(await readFile(f.cache('a'), 'utf8'), '{}')
  assert.deepEqual(f.medium.get('a'), marker)
  assert.equal(f.archived.has('a'), true)
  assert.equal(f.members.has('a'), true)
  assert.deepEqual(f.calls, [])
  await absent(join(f.home, 'sessions.trash-purge-staging'))
  assert.equal(f.logs.some(row => row.stage === 'logs-absent'), false)
}
let count = 0
async function test(name, run) {
  const f = await fixture()
  try { await run(f); count++; console.log(`PASS: ghost ${name}`) }
  finally { await f.dispose() }
}

await test('absent directory cleans ghost ownership, archive, marker and cache in order', async f => {
  await f.create()
  await rm(f.directory('a'), { recursive: true })
  f.calls.length = 0; f.logs.length = 0
  f.trash.purger.deleteStaged = async () => assert.fail('ghost must not touch staging')
  f.trash.purger.systemTrash.move = async () => assert.fail('ghost must not rename')
  f.trash.purger.systemTrash.move = async () => assert.fail('ghost must not rm logs')
  assert.equal(await f.trash.removeFromTrash('a'), true)
  await clean(f)
  assert.deepEqual(f.calls, ['detach:0', 'unarchive'])
  assert.deepEqual(f.logs.map(row => row.stage), ['logs-absent', 'detach', 'unarchive', 'marker', 'removed', 'projection', 'complete'])
  const event = (await rows(f)).find(row => row.stage === 'logs-absent')
  assert.equal(event.result, 'ok')
  assert.match(event.reason, /stat returned undefined.*cleaning records only/)
  await absent(join(f.home, 'sessions.trash-purge-staging'))
})

await test('stale Client re-trash after a successful physical delete can be deleted again', async f => {
  await f.create()
  assert.equal(await f.trash.removeFromTrash('a'), true)
  await f.trash.trashSession('a')
  assert.equal(f.medium.has('a'), true); assert.equal(f.archived.has('a'), true)
  f.calls.length = 0; f.logs.length = 0
  assert.equal(await f.trash.removeFromTrash('a'), true)
  await clean(f)
  assert.deepEqual(f.calls, ['unarchive'])
  assert.ok(f.logs.some(row => row.stage === 'logs-absent'))
  assert.equal(f.logs.some(row => row.stage === 'moved-to-trash' || row.stage === 'detach'), false)
})

await test('empty counts ghosts as successful record cleanup and preserves other sessions', async f => {
  await f.create('a'); await f.create('b')
  await f.trash.restoreSession('b')
  await rm(f.directory('a'), { recursive: true })
  assert.equal(await f.trash.emptyTrash(), 1)
  await clean(f)
  assert.equal(await readFile(f.log('b'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  assert.equal(f.members.has('b'), true)
  assert.ok((await rows(f)).some(row => row.action === 'emptyTrash' && row.stage === 'logs-absent'))
})

for (const code of ['EIO', 'ENOENT']) {
  await test(`stat throws ${code}: refuse without changing payload or records`, async f => {
    await f.create()
    const marker = structuredClone(f.medium.get('a'))
    f.calls.length = 0; f.logs.length = 0
    const error = Object.assign(new Error(`injected stat ${code}`), { code })
    f.hooks.stat = () => { throw error }
    await assert.rejects(f.trash.removeFromTrash('a'), failure => {
      assert.equal(failure.stage, 'gate'); assert.equal(failure.cause, error); return true
    })
    await untouched(f, marker)
  })
}

for (const mode of ['wrong-id', 'non-jsonl', 'relative', 'no-location']) {
  await test(`unreliable ${mode} snapshot refuses without record cleanup`, async f => {
    await f.create()
    const marker = structuredClone(f.medium.get('a'))
    f.calls.length = 0; f.logs.length = 0
    f.hooks.stat = () => ({ header: { id: mode === 'wrong-id' ? 'b' : 'a' },
      ...(mode === 'no-location' ? {} : { location: { kind: mode === 'non-jsonl' ? 'other' : 'jsonl',
        path: mode === 'relative' ? 'session.v4.jsonl' : f.log('a') } }) })
    await assert.rejects(f.trash.removeFromTrash('a'), /\[gate\].*No reliable JSONL/)
    await untouched(f, marker)
  })
}

for (const mode of ['not-trash', 'unarchived', 'unarchived-during-stat']) {
  await test(`absent logs still require marker and archive: ${mode}`, async f => {
    await f.create()
    await rm(f.directory('a'), { recursive: true })
    if (mode === 'not-trash') await (await f.trash.domain()).table('trash').delete('a')
    if (mode === 'unarchived') f.archived.delete('a')
    if (mode === 'unarchived-during-stat') f.hooks.stat = () => { f.archived.delete('a') }
    f.calls.length = 0; f.logs.length = 0
    await assert.rejects(f.trash.removeFromTrash('a'), /\[gate\]/)
    assert.deepEqual(f.calls, [])
    assert.equal(f.medium.has('a'), mode !== 'not-trash')
    assert.equal(f.members.has('a'), true)
    assert.equal(await readFile(f.cache('a'), 'utf8'), '{}')
    assert.equal(f.logs.some(row => row.stage === 'logs-absent'), false)
  })
}

for (const point of ['locked', 'intent']) {
  await test(`absence during ${point} recheck must not become ghost cleanup`, async f => {
    await f.create()
    f.calls.length = 0; f.logs.length = 0
    f.hooks.report = (id, stage) => {
      if (stage === point) f.trash.purger.observe = async () => undefined
    }
    await assert.rejects(f.trash.removeFromTrash('a'), /\[recheck\].*identity changed/i)
    assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
    assert.equal(f.medium.has('a'), true); assert.equal(f.archived.has('a'), true)
    assert.deepEqual(f.calls, [])
    assert.equal(f.logs.some(row => row.stage === 'logs-absent'), false)
  })
}

await test('existing staged receipt resumes even when stat throws', async f => {
  await f.create()
  f.hooks.detach = () => { throw new Error('injected cleanup failure') }
  await assert.rejects(f.trash.removeFromTrash('a'), /\[detach\]/)
  f.hooks.stat = () => { throw new Error('stat unavailable after move') }
  delete f.hooks.detach
  assert.equal(await f.trash.removeFromTrash('a'), true)
  await clean(f)
  assert.ok(f.logs.some(row => row.stage === 'recovery' && row.result === 'deleted'))
  assert.equal(f.logs.some(row => row.stage === 'logs-absent'), false)
})

await test('invalid existing receipt cannot fall through to absent-log cleanup', async f => {
  await f.create()
  const table = (await f.trash.domain()).table('trash')
  const record = { ...table.get('a'), purge: { source: f.directory('a'), target: join(f.home, 'outside', 'a-invalid'),
    dev: '1', ino: '1', deleting: true, logsDeleted: true } }
  await table.put('a', record)
  await rm(f.directory('a'), { recursive: true })
  f.calls.length = 0; f.logs.length = 0
  await assert.rejects(f.trash.removeFromTrash('a'), /Unsafe persisted purge intent/)
  assert.deepEqual(f.medium.get('a'), record)
  assert.equal(f.archived.has('a'), true); assert.equal(f.members.has('a'), true)
  assert.deepEqual(f.calls, [])
  assert.equal(f.logs.some(row => row.stage === 'logs-absent'), false)
})

await test('restart uses another reliable stat for ghost projection home', async f => {
  await f.create('a'); await f.create('b')
  await f.trash.restoreSession('b')
  await rm(f.directory('a'), { recursive: true })
  const restarted = await fixture(f.home)
  try {
    assert.equal(await restarted.trash.removeFromTrash('a'), true)
    await clean(restarted)
    assert.equal(await readFile(f.log('b'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
  } finally { await restarted.dispose(true) }
})

await test('no reliable home still cleans records with logger fallback and projection warning', async f => {
  await f.create()
  await rm(f.directory('a'), { recursive: true })
  const restarted = await fixture(f.home)
  try {
    assert.equal(await restarted.trash.removeFromTrash('a'), true)
    assert.equal(restarted.medium.has('a'), false)
    assert.equal(restarted.archived.has('a'), false); assert.equal(restarted.members.has('a'), false)
    assert.equal(await readFile(f.cache('a'), 'utf8'), '{}', 'no guessed cache home')
    assert.ok(restarted.fallbacks.some(row => row.stage === 'logs-absent' && row.result === 'ok'))
    assert.ok(restarted.fallbacks.some(row => row.stage === 'projection' && row.result === 'warning'))
  } finally { await restarted.dispose(true) }
})

console.log(`PASS: ghost regressions ${count} passed, 0 skipped (synthetic homes only)`)
