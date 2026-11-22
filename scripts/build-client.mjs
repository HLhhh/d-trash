import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: `import registerClient from './src/client.ts'
import contribution from './dist/typert.remote-client.js'
registerClient(contribution)
`,
    resolveDir: root,
    sourcefile: 'trash-client-entry.js',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  write: false,
  metafile: true,
})
// Everything except the lazy factory's React request must be in this bundle.
if (Object.values(result.metafile.outputs).some(output => output.imports.length > 0)) {
  throw new Error('Trash Client must not depend on external runtime modules')
}
writeFileSync(resolve(root, 'dist/client.js'), result.outputFiles[0].contents)
// The ESM registration helper is an internal build input, not a public export
// of the resulting classic script.
writeFileSync(resolve(root, 'dist/client.d.ts'), 'export {}\n')
console.log('Client: bundled generated Remote codecs and lazy React plugin')
