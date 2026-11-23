import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const executable = process.env.DSH_NODE_EXECUTABLE
if (!executable || !existsSync(executable) || !process.env.DSH_INSTALL_DIR) {
  console.log('SKIP: discovery requires DSH_NODE_EXECUTABLE (installed Electron) and DSH_INSTALL_DIR; no DSH/profile was changed')
} else {
  const result = spawnSync(executable, [fileURLToPath(new URL('./discovery.cjs', import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`Discovery terminated: ${result.signal}`)
  process.exitCode = result.status ?? 1
}
