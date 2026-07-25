/**
 * The single implementation of "where does the token come from".
 *
 * Kept in one place so the precedence cannot be duplicated inconsistently across commands, and
 * so `weeek auth status` and `weeek doctor` report exactly what a real request would use.
 *
 * Precedence:
 *   1. --token-file <path> / token on stdin   explicit, per-invocation
 *   2. WEEEK_TOKEN                            automation, containers, CI
 *   3. weeek.env near the working directory   per-project, see auth/env-file.ts
 *   4. the profile's declared backend         keychain or file — never both
 *
 * The real environment deliberately outranks `weeek.env`: a file discovered by walking up the
 * tree must never override what the caller typed or what CI injected.
 *
 * There is deliberately no `--token <value>` flag: a secret in argv leaks into shell history
 * and is visible in `ps` to every user on the machine.
 */

import { readFile } from 'node:fs/promises'
import { WeeekError } from '../api/errors.ts'
import { profileFrom, readConfig } from '../config.ts'
import { disabledByEnv, type EnvFile, loadEnvFile } from './env-file.ts'
import { registerSecret } from './redact.ts'
import { storeFor } from './store.ts'

export type TokenSource = 'token-file' | 'stdin' | 'env' | 'env-file' | 'keychain' | 'file'

export interface ResolvedToken {
  token: string
  source: TokenSource
  profile: string
  baseUrl: string | undefined
  /** Path of the `weeek.env` that contributed, when one did. Reported, never guessed at. */
  envFilePath: string | undefined
}

export interface ResolveOptions {
  profile?: string
  tokenFile?: string
  /** Pre-read stdin content, when `--stdin` was used. */
  stdinToken?: string
  env?: NodeJS.ProcessEnv
  /** Set false by `--no-env-file`; `WEEEK_NO_ENV_FILE` does the same through the environment. */
  useEnvFile?: boolean
  cwd?: string
}

function clean(raw: string): string {
  return raw.trim()
}

export async function resolveToken(options: ResolveOptions = {}): Promise<ResolvedToken> {
  const env = options.env ?? process.env

  const envFile: EnvFile | undefined = await loadEnvFile({
    enabled: options.useEnvFile !== false && !disabledByEnv(env),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })

  const config = await readConfig(env)
  // A project can pin its profile, but only when nothing more explicit said otherwise.
  const { name: profileName, profile } = profileFrom(
    config,
    options.profile ?? env.WEEEK_PROFILE ?? envFile?.values.WEEEK_PROFILE,
  )
  const baseUrl = env.WEEEK_BASE_URL ?? envFile?.values.WEEEK_BASE_URL ?? profile?.baseUrl

  const finish = (token: string, source: TokenSource): ResolvedToken => {
    if (token === '') {
      throw new WeeekError({ kind: 'auth', message: `Token from ${source} is empty.` })
    }
    registerSecret(token)
    return { token, source, profile: profileName, baseUrl, envFilePath: envFile?.path }
  }

  if (options.tokenFile !== undefined) {
    let contents: string
    try {
      contents = await readFile(options.tokenFile, 'utf8')
    } catch (cause) {
      throw new WeeekError({
        kind: 'auth',
        message: `Could not read token file ${options.tokenFile}: ${(cause as Error).message}`,
        cause,
      })
    }
    return finish(clean(contents), 'token-file')
  }

  if (options.stdinToken !== undefined) return finish(clean(options.stdinToken), 'stdin')

  const fromEnv = env.WEEEK_TOKEN
  if (fromEnv !== undefined && clean(fromEnv) !== '') return finish(clean(fromEnv), 'env')

  const fromFile = envFile?.values.WEEEK_TOKEN
  if (fromFile !== undefined) return finish(clean(fromFile), 'env-file')

  if (profile) {
    // The declared backend is authoritative. A keychain read that fails throws from the store
    // rather than degrading to the file — see auth/store.ts.
    const store = storeFor(profile.backend, env)
    const stored = await store.get(profileName)
    if (stored) return finish(clean(stored), profile.backend)
  }

  throw new WeeekError({
    kind: 'auth',
    message:
      `No API token for profile "${profileName}". ` +
      `Sign in with \`weeek auth login\`, set WEEEK_TOKEN, ` +
      `or put WEEEK_TOKEN in a weeek.env beside your project. ` +
      `Get a token from your WEEEK workspace settings, section API.`,
  })
}

/** Reads a token piped on stdin, e.g. `printf %s "$TOKEN" | weeek auth login --stdin`. */
export async function readTokenFromStdin(
  stream: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}
