import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'trash-typert-')))

function stageDependency(name, destination) {
  // Resolve the package root before copying. Never preserve links into the
  // dependency entity, nor copy a pnpm package's private dependency tree.
  const source = realpathSync(join(root, 'node_modules', '@deepseek-ai', name))
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => basename(path) !== 'node_modules',
  })
  symlinkSync(join(root, 'node_modules'), join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
}

try {
  // rc.5 analyzes packages/ projects and lib/ exports only. Stage the authored
  // Host sources in that layout; keep this standalone bundle's dist/ contract.
  const packageDir = join(temporary, 'packages', 'trash')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  cpSync(join(root, 'src', 'index.ts'), join(packageDir, 'src', 'index.ts'))
  cpSync(join(root, 'src', 'types.ts'), join(packageDir, 'src', 'types.ts'))
  for (const file of ['purge.ts', 'write-lease.ts', 'fs-retry.ts']) cpSync(join(root, 'src', file), join(packageDir, 'src', file))
  cpSync(join(root, 'src', 'operation-log.ts'), join(packageDir, 'src', 'operation-log.ts'))
  symlinkSync(join(root, 'node_modules'), join(packageDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  manifest.exports = {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './types': { types: './lib/types/types.d.ts', default: './lib/types/types.js' },
    './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
  }
  manifest.files = ['lib/typert.host.js', 'lib/typert.host.d.ts',
    'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts', 'lib/typert.remote-client.d.ts.map']
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
  const { compilerOptions } = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
  // The analyzer recognizes Remote symbols by their registered package owner.
  // Register the exact installed protocol source alongside the bundle.
  const protocolDir = join(temporary, 'packages', 'protocol')
  stageDependency('dsh-typert-protocol', protocolDir)
  const sessionDir = join(temporary, 'packages', 'session')
  stageDependency('dsh-session', sessionDir)
  const analysisOptions = { ...compilerOptions, allowImportingTsExtensions: true, noEmit: true,
    rootDir: temporary,
    types: ['node'],
    typeRoots: [join(root, 'node_modules', '@types')],
    lib: ['ES2022', 'ESNext.Disposable', 'DOM'],
    paths: {
      '@deepseek-ai/dsh-typert-protocol': [join(protocolDir, 'src', 'index.ts')],
      '@deepseek-ai/dsh-session/types': [join(sessionDir, 'src', 'types.ts')],
    },
  }
  const config = { compilerOptions: analysisOptions, include: ['src/index.ts'] }
  writeFileSync(join(packageDir, 'tsconfig.host.json'), JSON.stringify(config))
  writeFileSync(join(protocolDir, 'tsconfig.host.json'), JSON.stringify(config))
  writeFileSync(join(sessionDir, 'tsconfig.host.json'), JSON.stringify({ ...config, include: ['src/types.ts'] }))
  writeFileSync(join(temporary, 'tsconfig.host.json'), JSON.stringify({
    compilerOptions: analysisOptions,
    files: [],
    references: ['trash', 'protocol', 'session'].map(name => ({ path: `./packages/${name}/tsconfig.host.json` })),
  }))

  const model = new WorkspaceAnalyzer({ root: temporary, packages: [manifest.name], faces: ['host'] }).analyze()
  const host = model.faces.find(face => face.face === 'host')
  const artifact = host && new FaceModelEmitter(host).emit(manifest.name)
  if (!artifact?.remote) {
    throw new Error('Expected one Trash Host artifact with Remote methods')
  }
  const outputs = {
    'typert.host.js': artifact.js,
    'typert.host.d.ts': artifact.dts,
    'typert.remote-client.js': artifact.remote.js,
    'typert.remote-client.d.ts': artifact.remote.dts,
    'typert.remote-client.d.ts.map': artifact.remote.dtsMap,
  }
  for (const [name, contents] of Object.entries(outputs)) {
    writeFileSync(join(root, 'dist', name), contents)
  }
  console.log('Typert: generated Host and Remote client artifacts (trash namespace)')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
