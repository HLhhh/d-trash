import assert from 'node:assert/strict'
import { lstat, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { OperationLog } from '../dist/operation-log.js'
import { fixture } from './phase4-fixture.mjs'

const path = f => join(f.home, 'logs', 'trash.log')
const rows = async f => {
  const text = await readFile(path(f), 'utf8')
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
let count = 0
async function test(name, run) {
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
      lock = await open(join(f.directory('a'), 'session.lock'), 'r+')
      await tryLockExclusive(lock.fd)
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
    } finally { await lock?.close() }
    const log = await rows(f)
    const failure = log.find(row => row.action === 'removeFromTrash' && row.stage === stage
      && row.result === (stage === 'projection' ? 'warning' : 'failed'))
    assert.ok(failure)
    assert.ok(failure.reason.length > 0)
    assert.equal(log.at(-1).result, stage === 'projection' ? 'ok' : 'failed')
  })
}

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
    const child = spawn(process.execPath, [new URL('./phase4-child.mjs', import.meta.url).pathname,
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

console.log(`PASS: operation-log ${count} isolated persistent JSONL scenarios; no real sessions`)
