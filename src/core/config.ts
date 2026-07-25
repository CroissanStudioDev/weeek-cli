/**
 * Configuration file handling: XDG locations, profiles, and file permissions.
 *
 * The config file holds a token when the `file` backend is in use, so its permissions are part
 * of the security model rather than a nicety — see `assertPrivate`.
 */

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { WeeekError } from './api/errors.ts'

export const DEFAULT_PROFILE = 'default'

/** Where a profile's token lives. See `auth/store.ts` for why the marker matters. */
export const TokenBackend = z.enum(['file', 'keychain'])
export type TokenBackend = z.infer<typeof TokenBackend>

const ProfileConfig = z.object({
  /** Present only for the `file` backend. */
  token: z.string().optional(),
  /**
   * Which store this profile committed to. Recorded explicitly so that a keychain profile
   * that cannot be read fails loudly instead of silently falling back to a file.
   */
  backend: TokenBackend.default('file'),
  baseUrl: z.string().optional(),
})
export type ProfileConfig = z.infer<typeof ProfileConfig>

const ConfigFile = z.object({
  version: z.literal(1).default(1),
  defaultProfile: z.string().default(DEFAULT_PROFILE),
  profiles: z.record(z.string(), ProfileConfig).default({}),
})
export type ConfigFile = z.infer<typeof ConfigFile>

const EMPTY_CONFIG: ConfigFile = { version: 1, defaultProfile: DEFAULT_PROFILE, profiles: {} }

/**
 * Config directory, honouring XDG_CONFIG_HOME.
 *
 * Windows has no XDG convention, so APPDATA is used there when set.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WEEEK_CONFIG_DIR) return env.WEEEK_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'weeek')
  if (platform() === 'win32' && env.APPDATA) return join(env.APPDATA, 'weeek')
  return join(homedir(), '.config', 'weeek')
}

export function configPath(env?: NodeJS.ProcessEnv): string {
  return join(configDir(env), 'config.json')
}

/**
 * Rejects a config file that other users can read.
 *
 * This is an error rather than a warning on purpose: WEEEK tokens are long-lived, unscoped and
 * cannot be rotated automatically, so a world-readable token file is a standing full-access
 * credential leak. Refusing is recoverable in one command; warning gets ignored.
 *
 * Skipped on Windows, where POSIX mode bits do not describe the real ACLs.
 */
export async function assertPrivate(path: string): Promise<void> {
  if (platform() === 'win32') return

  let mode: number
  try {
    mode = (await stat(path)).mode
  } catch {
    return // Missing file is not a permissions problem.
  }

  const tooOpen = mode & 0o077
  if (tooOpen === 0) return

  throw new WeeekError({
    kind: 'auth',
    message:
      `${path} is readable by other users (mode ${(mode & 0o777).toString(8)}). ` +
      `It holds an API token that grants full workspace access. ` +
      `Fix it with: chmod 600 ${path}`,
  })
}

export async function readConfig(env?: NodeJS.ProcessEnv): Promise<ConfigFile> {
  const path = configPath(env)

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return structuredClone(EMPTY_CONFIG)
  }

  await assertPrivate(path)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new WeeekError({
      kind: 'input',
      message: `${path} is not valid JSON. Fix or delete it, then run \`weeek auth login\`.`,
      cause,
    })
  }

  const result = ConfigFile.safeParse(parsed)
  if (!result.success) {
    throw new WeeekError({
      kind: 'input',
      message: `${path} has an unexpected shape: ${result.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    })
  }
  return result.data
}

/** Writes the config with owner-only permissions, creating the directory if needed. */
export async function writeConfig(config: ConfigFile, env?: NodeJS.ProcessEnv): Promise<void> {
  const path = configPath(env)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // `mode` on writeFile only applies when creating, so chmod unconditionally afterwards.
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  if (platform() !== 'win32') await chmod(path, 0o600)
}

export function profileFrom(
  config: ConfigFile,
  name: string | undefined,
): { name: string; profile: ProfileConfig | undefined } {
  const resolved = name ?? config.defaultProfile
  return { name: resolved, profile: config.profiles[resolved] }
}
