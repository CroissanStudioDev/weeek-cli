/**
 * End-to-end checks against the built CLI.
 *
 * Everything here is a property of the *process* — exit status, which stream something landed
 * on, whether ANSI appeared — and none of it is observable from a unit test that calls a
 * function. Two regressions that unit tests happily missed live here as cases: colour forced on
 * in a pipe (Commander reports `--no-color` as `color: true` even when nobody passed it), and
 * usage errors exiting 1 because Commander called `process.exit` before our mapping ran.
 *
 * Skipped, loudly, when `dist/` has not been built.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI = resolve(import.meta.dirname, '../../dist/weeek.js')
const built = existsSync(CLI)

/** A config directory that is empty and private to this run: no token, no keychain. */
const configDir = built ? mkdtempSync(join(tmpdir(), 'weeek-e2e-')) : ''

const ESC = String.fromCharCode(27)

function run(args: string[], env: Record<string, string> = {}) {
  // The colour variables are *removed*, not blanked. Node treats an empty `NO_COLOR` alongside an
  // empty `FORCE_COLOR` as both being set and prints a warning to stderr about it — which lands
  // in the output these tests assert on, and only on runners where the harness happens to spawn
  // Node. Inheriting the CI runner's own values is not an option either, so: a clean slate,
  // minus whatever the case sets explicitly.
  const inherited = { ...process.env }
  for (const name of ['NO_COLOR', 'FORCE_COLOR', 'WEEEK_TOKEN']) delete inherited[name]

  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...inherited, WEEEK_CONFIG_DIR: configDir, ...env },
  })
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

describe.skipIf(!built)('the built CLI', () => {
  describe('exit codes', () => {
    const cases: [string, string[], number][] = [
      ['--help', ['--help'], 0],
      ['--version', ['--version'], 0],
      ['a namespace help', ['task', 'list', '--help'], 0],
      ['an unknown command', ['task', 'bogus'], 2],
      ['a missing argument', ['task', 'get'], 2],
      ['an unknown flag', ['task', 'list', '--definitely-not-a-flag'], 2],
      ['a command needing credentials', ['task', 'get', '1'], 3],
      ['doctor without credentials', ['doctor', '--json'], 0],
      ['schema', ['schema', '--json'], 0],
    ]

    it.each(cases)('%s exits %s', (_name, args, expected) => {
      expect(run(args).code, args.join(' ')).toBe(expected)
    })
  })

  describe('stream discipline', () => {
    it('puts JSON on stdout and nothing on stderr', () => {
      const { stdout, stderr, code } = run(['schema', '--json'])
      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(JSON.parse(stdout)).toHaveLength(153)
    })

    it('keeps doctor’s commentary off stdout in table mode', () => {
      // Diagnostics are commentary, not a payload; stdout must stay empty for pipes.
      const { stdout, stderr } = run(['doctor', '--output', 'table'])
      expect(stdout).toBe('')
      expect(stderr).toContain('registry')
    })
  })

  describe('colour', () => {
    it('emits no ANSI when stdout is a pipe', () => {
      // Regression: Commander materialises `--no-color` as `color: true`, which read as an
      // explicit request for colour and forced ANSI into piped output.
      const { stdout, stderr } = run(['doctor', '--output', 'table'])
      expect(stdout + stderr).not.toContain(ESC)
    })

    it('emits ANSI when FORCE_COLOR asks for it', () => {
      const { stderr } = run(['doctor', '--output', 'table'], { FORCE_COLOR: '1' })
      expect(stderr).toContain(ESC)
    })

    it('obeys NO_COLOR over FORCE_COLOR', () => {
      const { stdout, stderr } = run(['doctor', '--output', 'table'], {
        FORCE_COLOR: '1',
        NO_COLOR: '1',
      })
      expect(stdout + stderr).not.toContain(ESC)
    })
  })

  describe('working without credentials', () => {
    it('describes a request under --dry-run rather than demanding a token', () => {
      const { stdout, code } = run([
        'task',
        'list',
        '--project-id',
        '4',
        '--completed',
        '--dry-run',
        '--json',
      ])
      expect(code).toBe(0)
      const request = JSON.parse(stdout) as { method: string; path: string; query: string }
      expect(request.method).toBe('GET')
      expect(request.path).toBe('/tm/tasks')
      // Booleans go on the wire as 0/1 — `true` is accepted and silently does not filter.
      expect(request.query).toBe('?projectId=4&completed=1')
    })

    it('does the same for the raw escape hatch', () => {
      const { stdout, code } = run([
        'api',
        'GET',
        '/tm/tasks',
        '--query',
        'projectId=4',
        '--dry-run',
        '--json',
      ])
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({ method: 'GET', path: '/tm/tasks' })
    })

    it('refuses to open the TUI without a terminal instead of hanging', () => {
      const { code, stderr } = run(['ui'])
      expect(code).toBe(2)
      expect(stderr).toContain('interactive terminal')
    })
  })
})

describe.skipIf(built)('e2e suite', () => {
  it('is skipped until `bun run build` has produced dist/weeek.js', () => {
    expect(built).toBe(false)
  })
})

describe.skipIf(!built)('--token-file reaches every command that resolves a token', () => {
  // `doctor` built its own resolve options and forgot to forward `--token-file`, so it told a
  // user who had just passed a token that there was none, and skipped the API check on top.
  // Five other call sites forwarded it correctly; nothing failed because nothing checked.
  // The token here is a syntactically valid string that is never sent: `--dry-run` and
  // `doctor`'s credentials check both stop before the network.
  const tokenFile = built ? join(mkdtempSync(join(tmpdir(), 'weeek-tok-')), 'token') : ''
  if (built) writeFileSync(tokenFile, 'token_from_a_file_123', { mode: 0o600 })

  it('doctor reports the token instead of claiming there is none', () => {
    const { stdout, code } = run(['--token-file', tokenFile, 'doctor', '--json'])
    expect(code).toBe(0)

    const checks = JSON.parse(stdout).checks as { name: string; ok: boolean; detail: string }[]
    const credentials = checks.find((check) => check.name === 'credentials')
    expect(credentials?.ok, credentials?.detail).toBe(true)
    expect(credentials?.detail).toContain('token-file')
  })

  it('auth status agrees about where the token came from', () => {
    const { stdout, code } = run(['--token-file', tokenFile, 'auth', 'status', '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout).source).toBe('token-file')
  })

  it('a generated command accepts it too', () => {
    const { code } = run(['--token-file', tokenFile, 'task', 'get', '1', '--dry-run', '--json'])
    expect(code).toBe(0)
  })
})

// POSIX shell pipelines. `cmd.exe` has no equivalent, and the behaviour under test belongs to
// the pipe, not to the platform — asserting it on Windows would test the harness.
describe.skipIf(!built || platform() === 'win32')(
  'a consumer that exits first is not the CLI crashing',
  () => {
    // `weeek schema --json | head -1` and friends close the pipe while output is still being
    // written. Node reports that as an asynchronous EPIPE with a stack trace on stderr, which
    // looked like a crash in a tool whose stated contract is "stdout is always safe to pipe".
    it('writes nothing to stderr when stdout is closed early', () => {
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} schema --json | head -1`,
        ],
        { encoding: 'utf8', env: { ...process.env, WEEEK_CONFIG_DIR: configDir } },
      )

      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe('[')
    })

    it('survives a consumer that dies immediately', () => {
      const result = spawnSync(
        '/bin/sh',
        [
          '-c',
          `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} schema --json 2>&1 >/dev/null | true`,
        ],
        { encoding: 'utf8', env: { ...process.env, WEEEK_CONFIG_DIR: configDir } },
      )

      expect(result.stdout).not.toContain('EPIPE')
      expect(result.stderr).not.toContain('EPIPE')
    })
  },
)
