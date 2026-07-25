/**
 * `weeek.env` — per-project settings, discovered by walking up from the working directory.
 *
 * The point is a project that talks to its own workspace without every invocation carrying
 * flags. That convenience is also the risk: a file found by walking up can change which
 * workspace you are talking to without anyone typing anything. Three things keep it honest.
 *
 * The search stops at the repository root, so a file two projects over is never in scope. The
 * real environment always wins over the file, so `WEEEK_TOKEN=… weeek …` and CI behave exactly
 * as before. And the file is reported by name in `weeek auth status` and `weeek doctor`, so the
 * answer to "which token is this using" is never a guess.
 *
 * Only three keys are read. A general dotenv loader would let a checked-in file change
 * behaviour in ways the person reading the command line could not see.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse as parsePath } from 'node:path'
import { assertPrivate } from '../config.ts'

export const ENV_FILE_NAME = 'weeek.env'

/** Everything the file may set. Anything else in it is ignored. */
export const ENV_FILE_KEYS = ['WEEEK_TOKEN', 'WEEEK_BASE_URL', 'WEEEK_PROFILE'] as const
export type EnvFileKey = (typeof ENV_FILE_KEYS)[number]

export interface EnvFile {
  path: string
  values: Partial<Record<EnvFileKey, string>>
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
const QUOTED = /^(['"])(.*)\1$/

/**
 * A deliberately small dotenv subset: `KEY=value`, `export KEY=value`, `#` comments, and
 * quotes around a value that needs them. No interpolation, no multi-line values — a token is a
 * single opaque string, and the extra syntax would only add ways to be surprised.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const match = LINE.exec(line)
    if (!match) continue

    const key = match[1] as string
    let value = (match[2] ?? '').trim()

    const quoted = QUOTED.exec(value)
    if (quoted) value = quoted[2] as string
    // An unquoted value ends at the first ` #`, the usual trailing-comment convention.
    else value = value.split(/\s+#/)[0]?.trim() ?? ''

    values[key] = value
  }

  return values
}

/**
 * The nearest `weeek.env` at or above `startDir`.
 *
 * The walk stops after the directory holding `.git` — the repository is the natural boundary
 * for "this project's credentials" — and never climbs past the home directory, so a stray file
 * high up cannot silently apply to everything.
 */
export function findEnvFile(startDir: string, home = homedir()): string | undefined {
  const root = parsePath(startDir).root
  let dir = startDir

  for (;;) {
    const candidate = join(dir, ENV_FILE_NAME)
    if (existsSync(candidate)) return candidate

    if (existsSync(join(dir, '.git'))) return undefined
    if (dir === home || dir === root) return undefined

    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export interface LoadEnvFileOptions {
  cwd?: string
  home?: string
  /** Set false by `--no-env-file` / `WEEEK_NO_ENV_FILE`. */
  enabled?: boolean
}

/**
 * Finds, permission-checks and reads the file. Returns undefined when there is nothing to load.
 *
 * The permission check is the same one the config file gets, and for the same reason: the file
 * holds a long-lived unscoped token, so world-readable is a standing credential leak rather
 * than an untidiness.
 */
export async function loadEnvFile(options: LoadEnvFileOptions = {}): Promise<EnvFile | undefined> {
  if (options.enabled === false) return undefined

  const path = findEnvFile(options.cwd ?? process.cwd(), options.home)
  if (!path) return undefined

  await assertPrivate(path)

  const parsed = parseEnvFile(await readFile(path, 'utf8'))
  const values: Partial<Record<EnvFileKey, string>> = {}
  for (const key of ENV_FILE_KEYS) {
    const value = parsed[key]?.trim()
    if (value !== undefined && value !== '') values[key] = value
  }

  return { path, values }
}

/** True when the environment asks for the file to be ignored. */
export function disabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const flag = env.WEEEK_NO_ENV_FILE
  return flag !== undefined && flag !== '' && flag !== '0' && flag !== 'false'
}
