import { open } from 'node:fs/promises'
import { once } from 'node:events'
import { acquireWriteLease } from '../dist/write-lease.js'
import { fixture } from './phase4-fixture.mjs'
import { OperationLog } from '../dist/operation-log.js'
const [mode, value] = process.argv.slice(2)
if (mode === 'audit') {
  // Explicit temporary fixture home, never the profile or an environment hint.
  const log = new OperationLog(async () => value, () => { process.exitCode = 1 })
  await Promise.all(Array.from({ length: 60 }, (_, i) =>
    log.write('trashSession', 'synthetic', 'concurrent', 'ok', `child:${process.argv[4]}:${i}`)))
} else if (mode === 'lock') {
  const lease = await acquireWriteLease(value)
  process.stdout.write('LOCKED\n')
  await once(process.stdin, 'data')
  await lease.release()
} else if (mode === 'crash') {
  const f = await fixture(value)
  f.hooks.report = (id, stage) => {
    if (stage === 'moved-to-trash') process.kill(process.pid, 'SIGKILL')
  }
  await f.trash.removeFromTrash('a')
  throw new Error('Crash hook was not reached')
}
