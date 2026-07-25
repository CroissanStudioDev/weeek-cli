#!/usr/bin/env node
/**
 * Entry point. Deliberately thin: parse globals, build the tree, dispatch.
 *
 * Nothing heavy is imported at module scope — the client, zod, Ink and prompts all arrive
 * through dynamic imports inside handlers, so `weeek --help` stays fast with 153 commands
 * registered.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { EXIT, EXIT_CODE_HELP, exitCodeFor } from './cli/exit-codes.ts'
import {
  defaultFormat,
  defaultStreams,
  isBrokenPipe,
  Output,
  type OutputFormat,
  type Streams,
  shouldUseColor,
} from './cli/output.ts'
import { buildRegistry } from './cli/registry.ts'
import type { GlobalOptions } from './cli/runner.ts'

// Replaced at build time with the version from package.json (`--define`), so a release cannot
// ship a binary that reports a version nobody published. `dev` when run from source.
const VERSION = process.env.WEEEK_CLI_VERSION ?? 'dev'

interface RawGlobals {
  profile?: string
  tokenFile?: string
  configDir?: string
  baseUrl?: string
  output?: OutputFormat
  json?: boolean
  color?: boolean
  quiet?: boolean
  verbose?: boolean
  yes?: boolean
  dryRun?: boolean
  validate?: boolean
  envFile?: boolean
}

export function createProgram(streams: Streams = defaultStreams()): Command {
  const program = new Command()

  program
    .name('weeek')
    .description(
      'Command-line client for the WEEEK task tracker.\n' +
        'Unofficial and not affiliated with WEEEK.',
    )
    .version(VERSION, '-V, --version')
    .option('--profile <name>', 'configuration profile to use')
    .option('--token-file <path>', 'read the API token from a file (never pass it as a flag)')
    .option('--config-dir <path>', 'override the configuration directory')
    .option('--base-url <url>', 'override the API base URL')
    .option('-o, --output <format>', 'output format: json, table or yaml')
    .option('--json', 'shorthand for --output json')
    .option('--no-color', 'disable ANSI colour')
    .option('-q, --quiet', 'suppress non-essential messages on stderr')
    .option('-v, --verbose', 'trace requests to stderr')
    .option('-y, --yes', 'do not prompt for confirmation')
    .option('--dry-run', 'print the request that would be sent, without sending it')
    .option('--no-env-file', 'ignore a weeek.env found near the working directory')
    .option(
      '--no-validate',
      'skip local request validation (the bundled spec is reconstructed and may be stricter than the API)',
    )
    .addHelpText(
      'after',
      `\nExit codes:\n${EXIT_CODE_HELP}\n\n` +
        'Authentication:\n' +
        '  weeek auth login              store a token for this machine\n' +
        '  WEEEK_TOKEN=…                 preferred in CI and containers\n\n' +
        'Data goes to stdout; progress and errors go to stderr, so piping is safe.\n',
    )

  // Without this, Commander calls process.exit(1) itself on a usage error — an unknown command
  // or a missing argument would leave with the generic failure code instead of the documented
  // "bad input" code 2. Subcommands inherit the override through addCommand().
  program.exitOverride()

  program.configureOutput({
    writeOut: (text) => streams.stdout.write(text),
    writeErr: (text) => streams.stderr.write(text),
  })

  return program
}

/** Reads the global flags before Commander has parsed subcommands. */
function globalsFrom(program: Command): { raw: RawGlobals; output: Output; global: GlobalOptions } {
  const raw = program.opts<RawGlobals>()
  const streams = defaultStreams()

  if (raw.configDir) process.env.WEEEK_CONFIG_DIR = raw.configDir

  // Commander defaults `--no-color` to `color: true`, which is indistinguishable from an
  // explicit `--color` — taking it at face value forced ANSI on even in a pipe. Only a value
  // that actually came from argv counts as the user's choice.
  const colorFlag = program.getOptionValueSource('color') === 'cli' ? raw.color : undefined
  const color = shouldUseColor(streams, colorFlag)
  const format: OutputFormat = raw.json ? 'json' : (raw.output ?? defaultFormat(streams))

  const output = new Output(streams, { format, color, quiet: raw.quiet === true })

  const global: GlobalOptions = {}
  if (raw.profile !== undefined) global.profile = raw.profile
  if (raw.tokenFile !== undefined) global.tokenFile = raw.tokenFile
  if (raw.baseUrl !== undefined) global.baseUrl = raw.baseUrl
  if (raw.verbose !== undefined) global.verbose = raw.verbose
  if (raw.quiet !== undefined) global.quiet = raw.quiet
  if (raw.yes !== undefined) global.yes = raw.yes
  if (raw.dryRun !== undefined) global.dryRun = raw.dryRun
  // Commander maps --no-validate to validate:false, and --no-env-file to envFile:false.
  if (raw.validate === false) global.noValidate = true
  if (raw.envFile === false) global.envFile = false

  return { raw, output, global }
}

/**
 * Confirmation prompt that refuses to hang.
 *
 * Without a TTY there is nobody to answer, so a destructive command fails with instructions
 * instead of blocking a script forever.
 */
async function confirmFactory(output: Output) {
  return async (question: string): Promise<boolean> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const { WeeekError } = await import('./core/api/errors.ts')
      throw new WeeekError({
        kind: 'input',
        message: `${question} Refusing to prompt without a terminal — pass --yes to confirm.`,
      })
    }
    const { confirm, isCancel } = await import('@clack/prompts')
    const answer = await confirm({ message: question })
    if (isCancel(answer)) {
      output.note('Cancelled.')
      return false
    }
    return answer === true
  }
}

/** Commander's own errors carry a `commander.*` code and have already been reported. */
function isCommanderError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false
  const code: unknown = (error as unknown as Record<string, unknown>).code
  return typeof code === 'string' && code.startsWith('commander.')
}

/**
 * `exitOverride` is not inherited by commands attached with `addCommand`, and the whole tree is
 * built that way — without this, a typo in a subcommand exits 1 from inside Commander instead
 * of reaching the exit-code mapping as a usage error.
 */
function overrideExitRecursively(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) overrideExitRecursively(child)
}

export async function main(argv: string[] = process.argv): Promise<number> {
  // A consumer that exits first — `| head -1`, a `jq` that rejects its own arguments, `less`
  // quit early — closes the pipe mid-write. Node surfaces that as an asynchronous EPIPE with a
  // full stack trace on stderr, which reads as a crash in the CLI when nothing went wrong in
  // it. Leaving quietly is what every other well-behaved pipeline member does.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (isBrokenPipe(error)) process.exit(EXIT.ok)
    })
  }

  const program = createProgram()

  // Parsed lazily inside the action so that --help never constructs an Output or touches env.
  let context: ReturnType<typeof globalsFrom> | undefined
  const contextFor = () => {
    context ??= globalsFrom(program)
    return context
  }

  const { runOperation } = await import('./cli/runner.ts')
  const runner = async (commandContext: Parameters<typeof runOperation>[0]) => {
    const { output, global } = contextFor()
    await runOperation(commandContext, {
      output,
      global,
      confirm: await confirmFactory(output),
    })
  }

  for (const namespace of buildRegistry(runner)) program.addCommand(namespace)

  const { registerExtraCommands } = await import('./commands/index.ts')
  registerExtraCommands(program, contextFor)
  overrideExitRecursively(program)

  try {
    await program.parseAsync(argv)
    return EXIT.ok
  } catch (error) {
    // Commander signals `--help` and `--version` as thrown errors once exitOverride is on, and
    // it has already written the text; those are successful runs, not failures.
    if (isCommanderError(error)) {
      return error.code === 'commander.help' ||
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version'
        ? EXIT.ok
        : EXIT.usage
    }

    const { output } = contextFor()
    const { WeeekError } = await import('./core/api/errors.ts')

    if (error instanceof WeeekError) {
      output.error(error.message)
      if (error.kind === 'rate-limit' && error.retryAfter !== undefined) {
        output.note(`Retry after ${error.retryAfter}s.`)
      }
    } else if (error instanceof Error) {
      output.error(error.message)
    } else {
      output.error(String(error))
    }

    return exitCodeFor(error)
  }
}

/**
 * True when this module was started as the program, rather than imported by a test.
 *
 * The obvious spelling — comparing `import.meta.url` with `file://` + `process.argv[1]` — is a
 * POSIX-only accident. On Windows argv[1] is `C:\dir\weeek.js` while the URL is
 * `file:///C:/dir/weeek.js`, so the two never match, `main()` never runs, and the CLI exits 0
 * having printed nothing: `npm i -g weeek-cli` produced a command that silently did nothing.
 * Nothing caught it until the end-to-end suite began running on the Windows runner.
 *
 * So: compare real paths. The URL form is kept as a fallback because in a `bun build --compile`
 * binary both sides are virtual `$bunfs` paths that resolve to nothing on disk.
 *
 * There is no unit test for this, on purpose. Node resolves `argv[1]` to an absolute path
 * before the program sees it, so no spelling of the path reproduces the fault on POSIX — a
 * test written here would pass against the broken version too. What guards it is the
 * end-to-end suite running on the Windows runner, which is where it surfaced.
 */
function startedAsProgram(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (import.meta.url === `file://${entry}`) return true

  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// Deliberately not top-level `await`: `bun build --compile --bytecode` compiles to CommonJS,
// which has no top-level await, and the entry point would fail to build for the binaries.
if (startedAsProgram()) {
  void main().then((code) => {
    process.exitCode = code
  })
}
