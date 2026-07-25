/**
 * Token storage backends.
 *
 * Two exist: a 0600 file (default, works everywhere including containers and CI) and the OS
 * keychain (opt-in, npm installs only).
 *
 * The rule that shapes this file: **a backend never silently substitutes another**. If a
 * profile says `keychain` and the keychain cannot be read — headless Linux with no D-Bus, a
 * container, a broken Secret Service — the command fails with instructions. Falling back to a
 * file would mean the user believes their token is in the OS keychain while it sits in
 * plaintext, and the keyring libraries do not report which backend actually served a request,
 * so a silent downgrade is undetectable after the fact.
 */

import { WeeekError } from '../api/errors.ts'
import type { ConfigFile, TokenBackend } from '../config.ts'
import { profileFrom, readConfig, writeConfig } from '../config.ts'

export interface TokenStore {
  readonly backend: TokenBackend
  get(profile: string): Promise<string | undefined>
  set(profile: string, token: string): Promise<void>
  delete(profile: string): Promise<void>
  /** Whether this backend can be used on this machine right now. */
  available(): Promise<boolean>
}

/** Stores the token inside the config file, which is kept at mode 0600. */
export class FileTokenStore implements TokenStore {
  readonly backend = 'file' as const

  constructor(private readonly env?: NodeJS.ProcessEnv) {}

  async available(): Promise<boolean> {
    return true
  }

  async get(profile: string): Promise<string | undefined> {
    const config = await readConfig(this.env)
    return profileFrom(config, profile).profile?.token
  }

  async set(profile: string, token: string): Promise<void> {
    const config = await readConfig(this.env)
    await writeConfig(this.withProfile(config, profile, { token, backend: 'file' }), this.env)
  }

  async delete(profile: string): Promise<void> {
    const config = await readConfig(this.env)
    const existing = config.profiles[profile]
    if (!existing) return
    const { token: _dropped, ...rest } = existing
    await writeConfig({ ...config, profiles: { ...config.profiles, [profile]: rest } }, this.env)
  }

  private withProfile(
    config: ConfigFile,
    profile: string,
    patch: { token?: string; backend: TokenBackend },
  ): ConfigFile {
    return {
      ...config,
      profiles: { ...config.profiles, [profile]: { ...config.profiles[profile], ...patch } },
    }
  }
}

const KEYCHAIN_SERVICE = 'weeek-cli'

interface KeyringEntry {
  getPassword(): string | null
  setPassword(password: string): void
  deletePassword(): boolean
}

/**
 * Stores the token in the OS keychain via `@napi-rs/keyring`.
 *
 * Loaded through a dynamic import and declared as an optional dependency for a concrete reason:
 * `bun build --compile` embeds `.node` addons unreliably (there is an open regression where
 * exports of several NAPI modules get mixed together), and packages resolved through
 * platform-specific optional dependencies — which this is — hit exactly that path. So the
 * compiled single-file binary ships **without** a keychain backend, by design, and core stays
 * free of native dependencies.
 */
export class KeychainTokenStore implements TokenStore {
  readonly backend = 'keychain' as const

  private async entryFor(profile: string): Promise<KeyringEntry> {
    let module: { Entry: new (service: string, account: string) => KeyringEntry }
    try {
      module = (await import('@napi-rs/keyring')) as unknown as typeof module
    } catch (cause) {
      throw new WeeekError({
        kind: 'auth',
        message:
          'The keychain backend is unavailable: the optional @napi-rs/keyring package is not ' +
          'installed. Standalone binaries never include it. ' +
          'Use `weeek auth login --backend file`, or set WEEEK_TOKEN.',
        cause,
      })
    }
    return new module.Entry(KEYCHAIN_SERVICE, profile)
  }

  async available(): Promise<boolean> {
    try {
      const entry = await this.entryFor('__probe__')
      entry.getPassword()
      return true
    } catch {
      return false
    }
  }

  async get(profile: string): Promise<string | undefined> {
    const entry = await this.entryFor(profile)
    try {
      return entry.getPassword() ?? undefined
    } catch (cause) {
      // Loud on purpose — see the file header.
      throw new WeeekError({
        kind: 'auth',
        message:
          `Profile "${profile}" is stored in the OS keychain, but it could not be read ` +
          `(${(cause as Error).message}). This is common on headless Linux, in containers and ` +
          `over SSH, where no Secret Service is running. ` +
          `Use WEEEK_TOKEN for automation, or move the profile with ` +
          `\`weeek auth login --backend file\`.`,
        cause,
      })
    }
  }

  async set(profile: string, token: string): Promise<void> {
    const entry = await this.entryFor(profile)
    entry.setPassword(token)

    // Record the commitment so a later read cannot quietly resolve to a different backend.
    const config = await readConfig()
    await writeConfig({
      ...config,
      profiles: {
        ...config.profiles,
        [profile]: { ...config.profiles[profile], backend: 'keychain', token: undefined },
      },
    })
  }

  async delete(profile: string): Promise<void> {
    const entry = await this.entryFor(profile)
    try {
      entry.deletePassword()
    } catch {
      // Nothing stored is an acceptable outcome for a delete.
    }
  }
}

export function storeFor(backend: TokenBackend, env?: NodeJS.ProcessEnv): TokenStore {
  return backend === 'keychain' ? new KeychainTokenStore() : new FileTokenStore(env)
}
