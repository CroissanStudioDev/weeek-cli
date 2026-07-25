/**
 * Build: npm artefacts by default, standalone binaries with `--binaries`.
 *
 * Two products come out of one source tree:
 *   - `dist/weeek.js`      the CLI, run by Node ≥ 22 through the `bin` entry
 *   - `dist/core/index.js` the SDK (`weeek-cli/api`), with hand-off types from tsc
 *   - `dist/bin/*`         optional self-contained binaries, one per platform
 *
 * `@napi-rs/keyring` is left external everywhere. It is an optional native dependency, and
 * bundling it would either fail on machines where it is absent or embed one platform's `.node`
 * into an artefact meant for all of them. In the compiled binaries it is absent by design —
 * see SECURITY.md; the file backend is what those builds use.
 */

import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')

const pkg = (await Bun.file(resolve(root, 'package.json')).json()) as { version: string }

/**
 * Modules that must stay outside the bundle: the optional native keyring, and Ink's
 * development-only devtools bridge, which Ink imports behind a `DEV` check and which is not a
 * dependency of ours.
 */
const EXTERNAL = ['@napi-rs/keyring', 'react-devtools-core']

/**
 * Compile targets. `bun-linux-x64-musl` is not optional: without it the binary segfaults on
 * Alpine and in every slim Docker image, which is exactly where people put a CLI.
 */
const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-x64-musl',
  'bun-linux-arm64',
  'bun-windows-x64',
] as const

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${command.join(' ')} exited with ${code}`)
}

async function buildBundles(): Promise<void> {
  const shared = {
    outdir: dist,
    target: 'node',
    minify: false,
    sourcemap: 'linked',
    external: EXTERNAL,
    define: { 'process.env.WEEEK_CLI_VERSION': JSON.stringify(pkg.version) },
  } as const

  const cli = await Bun.build({
    ...shared,
    entrypoints: [resolve(root, 'src/index.ts')],
    naming: { entry: 'weeek.js', chunk: 'chunks/[name]-[hash].js' },
    // Code splitting is what keeps the laziness real: without it every dynamic `import()` is
    // folded into the entry file, so Ink, React and the prompt library are parsed on `--help`,
    // and their externals (react-devtools-core) get hoisted into a top-level import that fails
    // to resolve at startup.
    splitting: true,
  })
  if (!cli.success) throw new AggregateError(cli.logs, 'CLI bundle failed')

  // The shebang comes from src/index.ts and the bundler keeps it on line 1. Adding one here —
  // via `banner` or by prepending — lands it on line 2, where Node reads it as a syntax error.
  const entry = resolve(dist, 'weeek.js')
  const first = (await Bun.file(entry).text()).split('\n', 1)[0] ?? ''
  if (!first.startsWith('#!'))
    throw new Error(`dist/weeek.js lost its shebang: ${first.slice(0, 40)}`)

  const sdk = await Bun.build({
    ...shared,
    entrypoints: [resolve(root, 'src/core/index.ts')],
    outdir: resolve(dist, 'core'),
    naming: 'index.js',
  })
  if (!sdk.success) throw new AggregateError(sdk.logs, 'SDK bundle failed')

  // The bundler does not emit declarations, so the published types come from tsc — over
  // tsconfig.build.json, which covers src/core only.
  await run(['bunx', 'tsc', '-p', resolve(root, 'tsconfig.build.json')])

  // `exports` points at dist/core/index.d.ts; tsc mirrors the source layout under dist/types.
  await Bun.write(resolve(dist, 'core/index.d.ts'), "export * from '../types/src/core/index.js'\n")

  await Bun.$`chmod +x ${resolve(dist, 'weeek.js')}`.quiet()
}

/**
 * A single-file executable cannot leave anything external: there is nothing to resolve against
 * at runtime. Ink imports `react-devtools-core` behind a `process.env.DEV === 'true'` check, and
 * it is not a dependency of ours, so it is replaced by a stub that explains itself if the check
 * ever fires. The keyring is handled the same way, and SECURITY.md documents its absence here.
 */
const stubExternals: import('bun').BunPlugin = {
  name: 'stub-externals',
  setup(build) {
    const pattern = new RegExp(`^(${EXTERNAL.join('|')})$`)
    build.onResolve({ filter: pattern }, (args) => ({ path: args.path, namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      const message = JSON.stringify(
        `${args.path} is not available in the standalone weeek binary — install from npm instead`,
      )
      // Importing the stub must succeed (Ink imports its devtools bridge unconditionally and
      // only *uses* it under DEV); touching it must fail loudly rather than misbehave. The
      // named exports are the ones the real modules provide.
      return {
        contents: `
          const fail = () => { throw new Error(${message}) }
          const stub = new Proxy(function () {}, { get: fail, apply: fail, construct: fail })
          export default stub
          export const Entry = stub
          export const connectToDevTools = stub
        `,
        loader: 'js',
      }
    })
  },
}

async function buildBinaries(): Promise<void> {
  for (const target of TARGETS) {
    const suffix = target.includes('windows') ? '.exe' : ''
    const name = `weeek-${target.replace('bun-', '')}${suffix}`
    console.log(`→ ${name}`)

    const result = await Bun.build({
      entrypoints: [resolve(root, 'src/index.ts')],
      // No bytecode, deliberately: it compiles to CommonJS, and Ink's `yoga-layout` dependency
      // uses top-level await, so the bundle does not build at all with it. Dropping the TUI to
      // buy back a few milliseconds of startup would be the wrong trade.
      compile: { target, outfile: resolve(dist, 'bin', name) },
      minify: true,
      // No source map: with `compile.outfile` it is named after the entrypoint, so all six
      // targets would write one shared `index.js.map` and the last build would win — a 3.7 MB
      // release asset describing whichever binary happened to be built last.
      sourcemap: 'none',
      define: { 'process.env.WEEEK_CLI_VERSION': JSON.stringify(pkg.version) },
      plugins: [stubExternals],
    })

    if (!result.success) throw new AggregateError(result.logs, `${name} failed to compile`)
  }
}

const wantsBinaries = process.argv.includes('--binaries')

await rm(dist, { recursive: true, force: true })
await buildBundles()
if (wantsBinaries) await buildBinaries()

console.log(
  `\nBuilt weeek-cli ${pkg.version}${wantsBinaries ? ` + ${TARGETS.length} binaries` : ''}`,
)
