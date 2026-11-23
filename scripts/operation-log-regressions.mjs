import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireWriteLease } from '../dist/write-lease.js'
import { TrashErrorCode, SESSION_LOCK_BUSY_PREFIX } from '../dist/types.js'
import { MAX_BYTES, KEEP, OperationLog } from '../dist/operation-log.js'
import { fixture } from './phase4-fixture.mjs'

const path = f => join(f.home, 'logs', 'trash.log')
const rowsAt = async file => {
  const text = await readFile(file, 'utf8')
  assert.ok(text.endsWith('\n'))
  return text.trimEnd().split('\n').map(line => {
    const row = JSON.parse(line)
    assert.deepEqual(Object.keys(row).sort(), ['ts', 'action', 'sessionId', 'stage', 'result', 'reason'].sort())
    assert.equal(new Date(row.ts).toISOString(), row.ts)
    assert.ok(row.sessionId === null || typeof row.sessionId === 'string')
    assert.ok(row.reason === null || typeof row.reason === 'string')
    return row
  })
}
const rows = f => rowsAt(path(f))
const allRows = async f => (await Promise.all(Array.from({ length: KEEP + 1 }, (_, i) =>
  rowsAt(path(f) + (i ? `.${i}` : '')).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })))).flat()
// Real production threshold, complete short JSONL records, no sparse filler or
// test-only policy override. Exact serialized rows are used for preservation QA.
const fill = async (f, tag, bytes = MAX_BYTES + 1, append = false) => {
  const record = { ts: '2026-11-23T00:00:00.000Z', action: 'trashSession', sessionId: tag,
    stage: 'seed', result: 'ok', reason: tag + ':' + '字'.repeat(1000) }
  const line = JSON.stringify(record) + '\n'
  const content = line.repeat(Math.ceil(bytes / Buffer.byteLength(line)))
  await writeFile(path(f), content, { mode: 0o600, flag: append ? 'a' : 'w' })
  return content.trimEnd().split('\n')
}
const diskLines = async f => (await Promise.all(Array.from({ length: KEEP + 1 }, async (_, i) =>
  (await readFile(path(f) + (i ? `.${i}` : ''), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })).split('\n').filter(Boolean)))).flat()
const assertLines = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort())
let count = 0, skipped = 0
async function test(name, run) {
  if (process.platform === 'win32' && /0700|symlink/.test(name)) {
    skipped++; console.log(`SKIP: operation-log ${name} (POSIX modes/symlink contract)`); return
  }
  const f = await fixture()
  try { await run(f); count++; console.log(`PASS: operation-log ${name}`) }
  finally { await f.dispose() }
}

await test('trash/restore success and failure each append one complete JSONL with ISO time and reason', async f => {
  await f.create()
  assert.deepEqual((await rows(f)).map(({ ts, ...row }) => row), [{
    action: 'trashSession', sessionId: 'a', stage: 'complete', result: 'ok', reason: null,
  }])
  f.hooks.unarchive = () => { throw new Error('restore denied\nsecond line') }
  await assert.rejects(f.trash.restoreSession('a'), /restore denied/)
  delete f.hooks.unarchive
  await f.trash.restoreSession('a')
  f.hooks.archive = () => { throw new Error('archive denied\nsecond line') }
  await assert.rejects(f.trash.trashSession('a'), /archive denied/)
  const log = await rows(f)
  assert.equal(log.length, 4)
  assert.deepEqual(log.slice(1).map(row => [row.action, row.stage, row.result]), [
    ['restoreSession', 'complete', 'failed'], ['restoreSession', 'complete', 'ok'],
    ['trashSession', 'complete', 'failed'],
  ])
  assert.match(log[1].reason, /restore denied\nsecond line/)
  assert.match(log[3].reason, /archive denied\nsecond line/)
})

await test('new logs directory is 0700, file 0600, existing bytes stay unchanged', async f => {
  await f.create()
  assert.equal((await lstat(join(f.home, 'logs'))).mode & 0o777, 0o700)
  assert.equal((await lstat(path(f))).mode & 0o777, 0o600)
  const before = await readFile(path(f), 'utf8')
  await f.trash.restoreSession('a')
  assert.ok((await readFile(path(f), 'utf8')).startsWith(before))
  assert.equal((await rows(f)).length, 2)
})

await test('domain failure is logged without changing the original rejection', async f => {
  await f.create()
  const original = f.trash.domain
  const error = new Error('domain unavailable')
  f.trash.domain = async () => { throw error }
  try { await assert.rejects(f.trash.restoreSession('a'), value => value === error) }
  finally { f.trash.domain = original }
  assert.match((await rows(f)).at(-1).reason, /domain unavailable/)
  assert.equal(f.medium.has('a'), true)
})

await test('all successful purge stages persist outside the deleted source', async f => {
  await f.create()
  await f.trash.removeFromTrash('a')
  const log = (await rows(f)).filter(row => row.action === 'removeFromTrash')
  assert.deepEqual(log.map(row => row.stage), ['gate', 'locked', 'recheck', 'intent', 'renamed',
    'unlocked', 'logs-deleted', 'delete-staged', 'detach', 'unarchive', 'marker', 'projection', 'complete'])
  assert.ok(log.every(row => row.sessionId === 'a' && row.result === 'ok' && row.reason === null))
})

for (const stage of ['gate', 'lock', 'recheck', 'intent', 'rename', 'delete-staged', 'detach', 'unarchive', 'marker', 'projection']) {
  await test(`purge ${stage} failure/warning is persisted with its cause`, async f => {
    await f.create()
    let lock
    if (stage === 'gate') f.archived.delete('a')
    if (stage === 'lock') {
      lock = await acquireWriteLease(f.directory('a'))
    }
    if (stage === 'recheck') {
      let reads = 0
      f.hooks.stat = () => { if (++reads === 2) throw new Error('injected recheck') }
    }
    if (stage === 'intent') f.hooks.put = (id, record) => { if (record.purge) throw new Error('injected intent') }
    if (stage === 'rename') f.hooks.report = async (id, reported) => {
      if (reported !== 'intent') return
      const target = f.medium.get(id).purge.target
      await mkdir(target)
      await writeFile(join(target, 'sentinel'), 'SYNTHETIC rename conflict')
    }
    if (stage === 'delete-staged') f.trash.purger.removeDirectory = async () => { throw new Error('injected rm') }
    if (stage === 'detach') f.hooks.detach = () => { throw new Error('injected detach') }
    if (stage === 'unarchive') f.hooks.unarchive = () => { throw new Error('injected unarchive') }
    if (stage === 'marker') f.hooks.marker = () => { throw new Error('injected marker') }
    if (stage === 'projection') f.trash.purger.clearProjection = async () => { throw new Error('injected projection') }
    try {
      if (stage === 'projection') assert.equal(await f.trash.removeFromTrash('a'), true)
      else await assert.rejects(f.trash.removeFromTrash('a'), new RegExp(`\\[${stage}\\]`))
    } finally { await lock?.release() }
    const log = await rows(f)
    const failure = log.find(row => row.action === 'removeFromTrash' && row.stage === stage
      && row.result === (stage === 'projection' ? 'warning' : 'failed'))
    assert.ok(failure)
    assert.ok(failure.reason.length > 0)
    assert.equal(log.at(-1).result, stage === 'projection' ? 'ok' : 'failed')
    if (stage === 'gate' || stage === 'lock') {
      const purge = log.filter(row => row.action === 'removeFromTrash')
      assert.ok(!purge.some(row => row.stage === 'locked' || row.stage === 'unlocked'),
        'a failed lease acquisition must never claim ownership or unlock')
      if (stage === 'lock') {
        assert.deepEqual(purge.map(row => [row.stage, row.result]), [['gate', 'ok'], ['lock', 'failed'], ['complete', 'failed']])
        assert.ok(failure.reason.startsWith(`Error: ${SESSION_LOCK_BUSY_PREFIX}`))
      }
    } else {
      assert.equal(log.filter(row => row.stage === 'unlocked').length, 1, 'an acquired lease is released once on later failure')
    }
  })
}

await test('busy delete and empty preserve stable wire marker, cause and data; neither logs an unlock', async f => {
  await f.create('a'); await f.create('b')
  const lock = await acquireWriteLease(f.directory('a'))
  try {
    await assert.rejects(f.trash.removeFromTrash('a'), error => {
      assert.equal(error.code, TrashErrorCode.SessionLockBusy)
      assert.ok(error.message.startsWith(SESSION_LOCK_BUSY_PREFIX))
      assert.match(error.message, /Physical deletion \[lock\] \(a\): Session lock is busy/)
      assert.equal(error.cause.cause.code, 'EBUSY')
      return true
    })
    await assert.rejects(f.trash.emptyTrash(), error => {
      assert.ok(error.message.startsWith(SESSION_LOCK_BUSY_PREFIX))
      assert.match(error.message, /1 deleted, 1 failed/)
      assert.equal(error.errors[0].code, TrashErrorCode.SessionLockBusy)
      return true
    })
    assert.equal(await readFile(f.log('a'), 'utf8'), 'SYNTHETIC TEST LOG ONLY\n')
    assert.equal(f.medium.has('a'), true)
    assert.equal(f.medium.get('a').purge, undefined)
    assert.equal(f.archived.has('a'), true)
    assert.equal(f.members.has('a'), true)
    assert.equal(f.medium.has('b'), false)
    const log = await rows(f)
    assert.ok(!log.some(row => row.sessionId === 'a' && (row.stage === 'locked' || row.stage === 'unlocked')))
    assert.deepEqual(log.filter(row => row.action === 'emptyTrash' && row.sessionId === 'b').map(row => row.stage),
      ['gate', 'locked', 'recheck', 'intent', 'renamed', 'unlocked', 'logs-deleted', 'delete-staged',
        'detach', 'unarchive', 'marker', 'projection', 'complete'])
  } finally { await lock.release() }
  assert.equal(await f.trash.removeFromTrash('a'), true)
})

await test('empty writes every item and partial-failure/success/zero summaries', async f => {
  await f.create('a'); await f.create('b')
  f.hooks.detach = id => { if (id === 'a') throw new Error('a detach denied') }
  await assert.rejects(f.trash.emptyTrash(), /1 deleted, 1 failed/)
  let log = await rows(f)
  assert.deepEqual(log.filter(row => row.action === 'emptyTrash' && row.stage === 'complete')
    .map(row => [row.sessionId, row.result]), [['a', 'failed'], ['b', 'ok']])
  assert.deepEqual([log.at(-1).sessionId, log.at(-1).stage, log.at(-1).result], [null, 'summary', 'failed'])
  assert.match(log.at(-1).reason, /1 deleted, 1 failed/)
  delete f.hooks.detach
  assert.equal(await f.trash.emptyTrash(), 1)
  log = await rows(f)
  assert.equal(log.at(-1).reason, '1 deleted, 0 failed')
  assert.ok(log.some(row => row.action === 'recovery' && row.stage === 'recovery' && row.result === 'deleted'))
  assert.equal(await f.trash.emptyTrash(), 0)
  assert.equal((await rows(f)).at(-1).reason, '0 deleted, 0 failed')
})

await test('recovery failure and retry persist using the original receipt after source removal', async f => {
  await f.create()
  const remove = f.trash.purger.removeDirectory.bind(f.trash.purger)
  f.trash.purger.removeDirectory = async () => { throw new Error('injected rm') }
  await assert.rejects(f.trash.removeFromTrash('a'), /injected rm/)
  // New Host, no cached home; stat/list can no longer locate this session.
  const restarted = await fixture(f.home)
  try {
    restarted.hooks.stat = () => { throw new Error('source is gone') }
    restarted.trash.purger.removeDirectory = async () => { throw new Error('recovery denied') }
    await assert.rejects(restarted.trash.removeFromTrash('a'), /recovery denied/)
    assert.ok((await rows(f)).some(row => row.action === 'recovery' && row.result === 'failed'
      && /recovery denied/.test(row.reason)))
    restarted.trash.purger.removeDirectory = remove
    await restarted.trash.removeFromTrash('a')
    assert.ok((await rows(f)).some(row => row.action === 'recovery' && row.result === 'deleted'))
    assert.equal(restarted.fallbacks.length, 0)
  } finally { await restarted.dispose(true) }
})

await test('write failure and a throwing fallback never change any Host operation result', async f => {
  await f.create()
  await rm(join(f.home, 'logs'), { recursive: true })
  await writeFile(join(f.home, 'logs'), 'SYNTHETIC blocking file')
  f.hooks.fallback = () => { throw new Error('fallback logger failed too') }
  await f.trash.restoreSession('a')
  await f.trash.trashSession('a')
  const remove = f.trash.purger.removeDirectory.bind(f.trash.purger)
  f.trash.purger.removeDirectory = async () => { throw new Error('primary rm failure') }
  await assert.rejects(f.trash.removeFromTrash('a'), /primary rm failure/)
  f.trash.purger.removeDirectory = remove
  assert.equal(await f.trash.emptyTrash(), 1)
  for (const action of ['trashSession', 'restoreSession', 'removeFromTrash', 'emptyTrash', 'recovery']) {
    assert.ok(f.fallbacks.some(row => row.action === action && typeof row.logError === 'string'), action)
  }
  assert.equal(f.medium.size, 0)
  assert.equal(await readFile(join(f.home, 'logs'), 'utf8'), 'SYNTHETIC blocking file')
  // A failed write must not poison the per-file queue; subsequent writes retry.
  await rm(join(f.home, 'logs'))
  await f.trash.emptyTrash()
  assert.equal((await rows(f)).at(-1).result, 'ok')
})

await test('symlink log directory/file is refused without touching its target or main operation', async f => {
  await f.create()
  await rm(join(f.home, 'logs'), { recursive: true })
  const outside = join(f.home, 'unrelated')
  await mkdir(outside)
  await writeFile(join(outside, 'trash.log'), 'SYNTHETIC untouched')
  await symlink(outside, join(f.home, 'logs'))
  await f.trash.restoreSession('a')
  await rm(join(f.home, 'logs'))
  await mkdir(join(f.home, 'logs'), { mode: 0o700 })
  await symlink(join(outside, 'trash.log'), path(f))
  await f.trash.trashSession('a')
  assert.equal(await readFile(join(outside, 'trash.log'), 'utf8'), 'SYNTHETIC untouched')
  assert.equal(f.fallbacks.length, 2)
})

await test('cold empty and missing-id failures use another session stat, ignoring wrong DSH_HOME', async f => {
  await f.create(); await f.trash.restoreSession('a')
  const restarted = await fixture(f.home)
  try {
    process.env.DSH_HOME = join(f.home, 'incorrect-home')
    assert.equal(await restarted.trash.emptyTrash(), 0)
    await assert.rejects(restarted.trash.removeFromTrash('missing'), /not in trash/)
    assert.equal((await rows(f)).at(-1).sessionId, 'missing')
    assert.equal(restarted.fallbacks.length, 0)
    await assert.rejects(lstat(process.env.DSH_HOME), { code: 'ENOENT' })
  } finally { await restarted.dispose(true) }
})

await test('no reliable home falls back without guessing a path or failing the operation', async f => {
  assert.equal(await f.trash.emptyTrash(), 0)
  assert.equal(f.fallbacks.length, 1)
  assert.equal(f.fallbacks[0].action, 'emptyTrash')
  assert.match(f.fallbacks[0].logError, /No reliable stat-derived home/)
  await assert.rejects(lstat(join(f.home, 'logs')), { code: 'ENOENT' })
})

await test('concurrent Host operations, logger instances and processes append without lost/interleaved lines', async f => {
  for (let i = 0; i < 12; i++) await f.create(`s${i}`)
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.trash.restoreSession(`s${i}`)))
  assert.equal((await rows(f)).length, 24)
  const writers = Array.from({ length: 4 }, () => new OperationLog(async () => f.home, () => assert.fail('unexpected fallback')))
  const children = [0, 1].map(index => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./phase4-child.mjs', import.meta.url)),
      'audit', f.home, String(index)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
    return once(child, 'exit').then(([code]) => assert.equal(code, 0, stderr))
  })
  await Promise.all([...children, ...Array.from({ length: 160 }, (_, i) =>
    writers[i % 4].write('trashSession', 'synthetic', 'concurrent', 'ok', `parent:${i}`))])
  const log = await rows(f)
  assert.equal(log.length, 24 + 160 + 120)
  assert.equal(new Set(log.filter(row => row.stage === 'concurrent').map(row => row.reason)).size, 280)
})


await test('MAX_BYTES boundary rotates on next append with complete rows and 0600 active file', async f => {
  assert.equal(MAX_BYTES, 4 * 1024 * 1024)
  assert.equal(KEEP, 3)
  await f.create()
  // Exactly at the limit does not rotate. The next small record crosses it.
  const base = { ts: '2026-11-23T00:00:00.000Z', action: 'trashSession', sessionId: 'boundary',
    stage: 'seed', result: 'ok', reason: '' }
  const overhead = Buffer.byteLength(JSON.stringify(base) + '\n')
  base.reason = 'x'.repeat(MAX_BYTES - overhead)
  const exact = JSON.stringify(base)
  await writeFile(path(f), exact + '\n')
  await f.trash.restoreSession('a')
  await assert.rejects(lstat(path(f) + '.1'), { code: 'ENOENT' })
  const before = await diskLines(f)
  await f.trash.trashSession('a')
  const log = await allRows(f)
  const rotate = log.find(row => row.action === 'log-rotate')
  assert.deepEqual([rotate.stage, rotate.result, rotate.sessionId], ['complete', 'ok', null])
  assert.match(rotate.reason, /archives=1\.\.3/)
  assert.match(rotate.reason, /trash.log -> trash.log.1/)
  assert.equal(f.fallbacks.length, 0)
  assertLines(await diskLines(f), [...before, ...((await readFile(path(f), 'utf8')).trimEnd().split('\n'))])
  assert.equal(log.filter(row => row.action === 'trashSession' && row.stage === 'complete').length, 1)
  if (process.platform !== 'win32') assert.equal((await lstat(path(f))).mode & 0o777, 0o600)
})

await test('KEEP retains three archives and evicts exactly the oldest generation', async f => {
  await f.create()
  const log = new OperationLog(async () => f.home, line => assert.fail(line))
  const generations = []
  for (let i = 0; i < KEEP + 1; i++) {
    const prior = (await readFile(path(f), 'utf8')).trimEnd().split('\n')
    generations.push([...prior, ...await fill(f, `generation:${i}`, MAX_BYTES + 1, true)])
    await log.write('trashSession', 'synthetic', 'retention', 'ok', `trigger:${i}`)
    const active = await rows(f)
    assert.equal(active[0].action, 'log-rotate')
    assert.equal(active[1].reason, `trigger:${i}`)
    // At each step every retained seed line is byte-for-byte intact.
    for (let n = 1; n <= Math.min(i + 1, KEEP); n++) {
      const archive = path(f) + `.${n}`
      await rowsAt(archive)
      assertLines((await readFile(archive, 'utf8')).trimEnd().split('\n'), generations[i - n + 1])
    }
  }
  await assert.rejects(lstat(path(f) + `.${KEEP + 1}`), { code: 'ENOENT' })
  const retained = await allRows(f)
  assert.ok(!retained.some(row => row.sessionId === 'generation:0'))
  for (let i = 1; i <= KEEP; i++) assert.ok(retained.some(row => row.sessionId === `generation:${i}`))
})

await test('symlink archive is refused before any rotation mutation and retry succeeds', async f => {
  await f.create()
  const seed = await fill(f, 'protected')
  const outside = join(f.home, 'unrelated')
  await writeFile(outside, 'SYNTHETIC untouched')
  await symlink(outside, path(f) + '.2')
  await f.trash.restoreSession('a')
  assert.equal(f.medium.has('a'), false)
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC untouched')
  await rm(path(f) + '.2')
  assertLines(await diskLines(f), seed)
  assert.ok(f.fallbacks.some(row => row.action === 'log-rotate' && row.stage === 'validate'))
  assert.ok(f.fallbacks.some(row => row.action === 'restoreSession' && row.result === 'ok'))
  await f.trash.trashSession('a')
  assert.equal((await rows(f))[0].action, 'log-rotate')
  assertLines((await readFile(path(f) + '.1', 'utf8')).trimEnd().split('\n'), seed)
})

await test('rotation failure leaves business success/original rejection intact and next call retries', async f => {
  await f.create()
  const seed = await fill(f, 'before-failure')
  await mkdir(path(f) + '.3')
  f.hooks.fallback = () => { throw new Error('fallback failed too') }
  await f.trash.restoreSession('a')
  const original = new Error('archive primary failure')
  f.hooks.archive = () => { throw original }
  await assert.rejects(f.trash.trashSession('a'), error => error === original)
  assertLines((await readFile(path(f), 'utf8')).trimEnd().split('\n'), seed)
  assert.equal(f.medium.has('a'), false)
  assert.ok(f.fallbacks.some(row => row.action === 'log-rotate' && row.result === 'failed'))
  assert.ok(f.fallbacks.some(row => row.action === 'trashSession' && row.reason.includes('archive primary failure')))
  delete f.hooks.archive
  await rm(path(f) + '.3', { recursive: true })
  await f.trash.trashSession('a')
  assertLines((await readFile(path(f) + '.1', 'utf8')).trimEnd().split('\n'), seed)
  assert.equal((await rows(f)).at(-1).result, 'ok')
})

await test('new active file failure after rename falls back and recovers without losing archive lines', async f => {
  await f.create()
  const seed = await fill(f, 'create-failure')
  const log = f.trash.operationLog
  const append = log.append.bind(log)
  log.append = async (file, record) => {
    if (record.action === 'log-rotate') await mkdir(file) // deterministic creation obstruction after rename
    await append(file, record)
  }
  await f.trash.restoreSession('a')
  assert.equal(f.medium.has('a'), false)
  assertLines((await readFile(path(f) + '.1', 'utf8')).trimEnd().split('\n'), seed)
  assert.ok(f.fallbacks.some(row => row.action === 'log-rotate' && row.stage === 'create:0'))
  assert.ok(f.fallbacks.some(row => row.action === 'restoreSession' && row.result === 'ok'))
  log.append = append
  await rm(path(f), { recursive: true })
  await f.trash.trashSession('a')
  assert.equal((await rows(f)).at(-1).result, 'ok')
  assertLines((await readFile(path(f) + '.1', 'utf8')).trimEnd().split('\n'), seed)
})

await test('busy rotation guard degrades conservatively and retry resumes after release', async f => {
  await f.create()
  const seed = await fill(f, 'busy')
  await mkdir(path(f) + '.rotate')
  await f.trash.restoreSession('a')
  assert.ok(f.fallbacks.some(row => row.action === 'log-rotate' && row.stage === 'guard'))
  assertLines((await readFile(path(f), 'utf8')).trimEnd().split('\n'), seed)
  await rm(path(f) + '.rotate', { recursive: true })
  await f.trash.trashSession('a')
  assert.equal((await rows(f))[0].action, 'log-rotate')
})

await test('concurrent processes and instances rotating preserve every retained whole JSONL line', async f => {
  await f.create()
  const seed = await fill(f, 'concurrent-rotate')
  const fallbacks = []
  const writers = Array.from({ length: 4 }, () => new OperationLog(async () => f.home, line => fallbacks.push(line)))
  // Large whole records force multiple rotations with all test lines still
  // inside KEEP. Each child starts its own OperationLog and process-local queue.
  const childSource = String.raw`
    import { OperationLog } from ${JSON.stringify(new URL('../dist/operation-log.js', import.meta.url).href)};
    const log = new OperationLog(async () => process.argv[1], line => { console.error(line); process.exitCode = 1 });
    await Promise.all(Array.from({length: 60}, (_, i) => log.write('trashSession', 'synthetic', 'rotate-concurrent', 'ok',
      'child:' + process.argv[2] + ':' + i + ':' + '字'.repeat(8000))));
  `
  const children = [0, 1].map(index => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, f.home, String(index)],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
    return once(child, 'exit').then(([code]) => assert.equal(code, 0, stderr))
  })
  const expected = Array.from({ length: 160 }, (_, i) => `parent:${i}:` + '字'.repeat(8000))
  for (let c = 0; c < 2; c++) for (let i = 0; i < 60; i++) expected.push(`child:${c}:${i}:` + '字'.repeat(8000))
  await Promise.all([...children, ...expected.slice(0, 160).map((reason, i) =>
    writers[i % writers.length].write('trashSession', 'synthetic', 'rotate-concurrent', 'ok', reason))])
  assert.deepEqual(fallbacks, [])
  const log = await allRows(f) // parses EVERY line, including seed/rotation records
  const rotations = log.filter(row => row.action === 'log-rotate')
  assert.ok(rotations.length >= 2 && rotations.length <= KEEP)
  assertLines(log.filter(row => row.stage === 'rotate-concurrent').map(row => row.reason), expected)
  assertLines((await diskLines(f)).filter(line => JSON.parse(line).stage === 'seed'), seed)
  assert.equal(log.length, seed.length + expected.length + rotations.length)
})

await test('another process holding an old descriptor writes complete late lines into archive .1', async f => {
  await f.create()
  const seed = await fill(f, 'old-handle')
  const late = JSON.stringify({ ts: '2026-11-23T00:00:00.000Z', action: 'trashSession', sessionId: 'synthetic',
    stage: 'old-handle', result: 'ok', reason: 'late old descriptor write' })
  const childSource = String.raw`
    import { open } from 'node:fs/promises';
    import { once } from 'node:events';
    const handle = await open(process.argv[1], 'a');
    const go = once(process.stdin, 'data'); process.stdout.write('READY'); await go;
    await handle.write(Buffer.from(process.argv[2] + '\n')); await handle.close();
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, path(f), late],
    { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
  const finished = once(child, 'exit')
  try {
    await once(child.stdout, 'data')
    await f.trash.restoreSession('a')
    child.stdin.end('GO')
    const [code] = await finished
    assert.equal(code, 0, stderr)
    await allRows(f)
    assertLines((await readFile(path(f) + '.1', 'utf8')).trimEnd().split('\n'), [...seed, late])
    assert.ok((await lstat(path(f) + '.1')).size > MAX_BYTES)
    assert.equal(f.fallbacks.length, 0)
  } finally { child.kill() }
})

console.log(`PASS: operation-log ${count} isolated persistent JSONL scenarios; ${skipped} explicitly skipped; no real sessions`)
