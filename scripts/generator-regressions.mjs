import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'trash-generator-test-')))

// Include every directory, file byte, and symlink target; do not follow links.
function snapshot(directory) {
  const result = []
  function visit(relative = '') {
    const path = join(directory, relative)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) result.push([relative, 'link', readlinkSync(path)])
    else if (stat.isDirectory()) {
      result.push([relative, 'directory'])
      for (const name of readdirSync(path).sort()) visit(join(relative, name))
    } else result.push([relative, 'file', createHash('sha256').update(readFileSync(path)).digest('hex')])
  }
  visit()
  return result
}

try {
  const project = join(temporary, 'project')
  const entities = join(temporary, 'dependency-entities')
  mkdirSync(join(project, 'scripts'), { recursive: true })
  mkdirSync(join(project, 'dist'))
  cpSync(join(root, 'src'), join(project, 'src'), { recursive: true })
  for (const file of ['package.json', 'tsconfig.json', 'scripts/generate-typert.mjs']) {
    cpSync(join(root, file), join(project, file))
  }
  const modules = join(project, 'node_modules')
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    if (entry === '@deepseek-ai') continue
    symlinkSync(join(root, 'node_modules', entry), join(modules, entry))
  }
  for (const name of readdirSync(join(root, 'node_modules', '@deepseek-ai'))) {
    const source = realpathSync(join(root, 'node_modules', '@deepseek-ai', name))
    let target = source
    if (['dsh-typert-protocol', 'dsh-session'].includes(name)) {
      target = join(entities, name)
      cpSync(source, target, { recursive: true, dereference: true,
        filter: path => basename(path) !== 'node_modules' })
      // A pnpm-like package entity may already have its own dependency tree.
      mkdirSync(join(target, 'node_modules'))
      writeFileSync(join(target, 'node_modules', 'sentinel'), 'must remain unchanged\n')
    }
    symlinkSync(target, join(modules, '@deepseek-ai', name), 'dir')
  }
  const before = snapshot(entities)
  const generated = spawnSync(process.execPath, [join(project, 'scripts', 'generate-typert.mjs')], {
    cwd: project, encoding: 'utf8', timeout: 60_000,
  })
  // Check for pollution even if the generator fails.
  assert.deepEqual(snapshot(entities), before, 'generation must not change linked dependency entities')
  assert.equal(generated.error, undefined)
  assert.equal(generated.status, 0, generated.stderr || generated.stdout)
  const artifacts = ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js',
    'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map']
  for (const name of artifacts) {
    assert.equal(readFileSync(join(project, 'dist', name), 'utf8'), readFileSync(join(root, 'dist', name), 'utf8'),
      `symlink-layout ${name} must match the normal build`)
  }
  console.log('PASS: M1 symlink dependency layout generates identical artifacts without changing dependency files/links/directories')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
