import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WeeekError } from '../api/errors.ts'
import { assertPrivate, configPath, readConfig, writeConfig } from '../config.ts'
import { clearSecrets, redact, redactValue, registerSecret, tokenHint } from './redact.ts'
import { resolveToken } from './resolve.ts'
import { FileTokenStore, KeychainTokenStore } from './store.ts'

let dir: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weeek-auth-'))
  env = { WEEEK_CONFIG_DIR: dir }
  clearSecrets()
})
afterEach(() => clearSecrets())

async function seedProfile(profile: string, config: Record<string, unknown>) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ version: 1, defaultProfile: profile, profiles: { [profile]: config } }),
    { mode: 0o600 },
  )
}

describe('token precedence', () => {
  it('prefers --token-file over the environment and the config', async () => {
    const file = join(dir, 'token.txt')
    await writeFile(file, 'from_the_file_123\n')
    await seedProfile('default', { token: 'from_config_123', backend: 'file' })

    const resolved = await resolveToken({
      tokenFile: file,
      env: { ...env, WEEEK_TOKEN: 'from_env_12345' },
    })

    expect(resolved.token).toBe('from_the_file_123')
    expect(resolved.source).toBe('token-file')
  })

  it('prefers stdin over the environment', async () => {
    const resolved = await resolveToken({
      stdinToken: '  from_stdin_1234  ',
      env: { ...env, WEEEK_TOKEN: 'from_env_12345' },
    })

    expect(resolved.token).toBe('from_stdin_1234')
    expect(resolved.source).toBe('stdin')
  })

  it('prefers WEEEK_TOKEN over the stored profile', async () => {
    await seedProfile('default', { token: 'from_config_123', backend: 'file' })

    const resolved = await resolveToken({ env: { ...env, WEEEK_TOKEN: 'from_env_12345' } })

    expect(resolved.token).toBe('from_env_12345')
    expect(resolved.source).toBe('env')
  })

  it('falls back to the stored profile last', async () => {
    await seedProfile('work', { token: 'from_config_123', backend: 'file' })

    const resolved = await resolveToken({ profile: 'work', env })

    expect(resolved.token).toBe('from_config_123')
    expect(resolved.source).toBe('file')
    expect(resolved.profile).toBe('work')
  })

  it('ignores an empty WEEEK_TOKEN instead of authenticating with nothing', async () => {
    await seedProfile('default', { token: 'from_config_123', backend: 'file' })

    const resolved = await resolveToken({ env: { ...env, WEEEK_TOKEN: '   ' } })

    expect(resolved.source).toBe('file')
  })

  it('explains how to sign in when there is no token anywhere', async () => {
    const error = await resolveToken({ env }).catch((e: WeeekError) => e)

    expect(error).toBeInstanceOf(WeeekError)
    expect((error as WeeekError).kind).toBe('auth')
    expect((error as WeeekError).message).toContain('weeek auth login')
    expect((error as WeeekError).message).toContain('WEEEK_TOKEN')
  })

  it('reports a missing token file rather than silently moving on', async () => {
    const error = await resolveToken({ tokenFile: join(dir, 'nope.txt'), env }).catch(
      (e: WeeekError) => e,
    )
    expect((error as WeeekError).kind).toBe('auth')
    expect((error as WeeekError).message).toContain('Could not read token file')
  })
})

// POSIX modes only. Windows has no equivalent — `chmod` there is a near no-op and the ACL a
// file inherits is not a mode — so `config.ts` deliberately skips both the chmod and the check
// on win32, and asserting either here would test the platform, not the code.
describe.skipIf(platform() === 'win32')('file permissions', () => {
  it('writes the config as owner-only', async () => {
    await writeConfig(
      { version: 1, defaultProfile: 'default', profiles: { default: { backend: 'file' } } },
      env,
    )

    const mode = (await stat(configPath(env))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('refuses to read a config other users can read', async () => {
    // An error, not a warning: WEEEK tokens are long-lived and unscoped, so a readable file is
    // a standing full-access leak, and warnings get ignored.
    await seedProfile('default', { token: 'from_config_123', backend: 'file' })
    await chmod(configPath(env), 0o644)

    const error = await readConfig(env).catch((e: WeeekError) => e)

    expect(error).toBeInstanceOf(WeeekError)
    expect((error as WeeekError).message).toContain('readable by other users')
    expect((error as WeeekError).message).toContain('chmod 600')
  })
})

describe('file permissions, everywhere', () => {
  it('accepts a missing file as a non-problem', async () => {
    await expect(assertPrivate(join(dir, 'absent.json'))).resolves.toBeUndefined()
  })

  it('never rejects a config it just wrote', async () => {
    // The round trip is the invariant that has to hold on every platform: whatever mode
    // `writeConfig` leaves behind, `readConfig` must accept it. On Windows both sides are
    // no-ops; on POSIX both are 0600. A one-sided change breaks this.
    await seedProfile('default', { token: 'from_config_123', backend: 'file' })

    await expect(readConfig(env)).resolves.toMatchObject({ version: 1 })
  })
})

describe('keychain backend refuses to degrade silently', () => {
  it('fails loudly when a keychain profile cannot be read', async () => {
    // The failure mode this guards against: the user believes the token is in the OS keychain
    // while it actually sits in a plaintext file. Keyring libraries do not report which backend
    // served a request, so a silent downgrade would be undetectable afterwards.
    await seedProfile('default', { backend: 'keychain' })

    const store = new KeychainTokenStore()
    const broken = {
      getPassword: () => {
        throw new Error('no Secret Service')
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: replacing a private hook for the test
    ;(store as any).entryFor = async () => broken

    const error = await store.get('default').catch((e: WeeekError) => e)

    expect(error).toBeInstanceOf(WeeekError)
    expect((error as WeeekError).message).toContain('could not be read')
    expect((error as WeeekError).message).toContain('--backend file')
    expect((error as WeeekError).message).toContain('WEEEK_TOKEN')
  })

  it('never resolves a keychain profile from the config file', async () => {
    // A leftover `token` next to `backend: keychain` must not be used — that would be the
    // silent fallback wearing a disguise.
    await seedProfile('default', { backend: 'keychain', token: 'leftover_plain_123' })

    const store = new KeychainTokenStore()
    // biome-ignore lint/suspicious/noExplicitAny: replacing a private hook for the test
    ;(store as any).entryFor = async () => ({ getPassword: () => null })

    expect(await store.get('default')).toBeUndefined()
  })
})

describe('file store', () => {
  it('round-trips a token and keeps the backend marker', async () => {
    const store = new FileTokenStore(env)
    await store.set('default', 'stored_token_123')

    expect(await store.get('default')).toBe('stored_token_123')
    const config = await readConfig(env)
    expect(config.profiles.default?.backend).toBe('file')
  })

  it('removes only the token on logout, keeping the profile', async () => {
    const store = new FileTokenStore(env)
    await store.set('work', 'stored_token_123')
    await store.delete('work')

    expect(await store.get('work')).toBeUndefined()
    const raw = await readFile(configPath(env), 'utf8')
    expect(raw).not.toContain('stored_token_123')
    expect(JSON.parse(raw).profiles.work).toBeDefined()
  })
})

describe('redaction', () => {
  it('masks a registered token anywhere in a string', () => {
    registerSecret('tok_abcdef123456')
    expect(redact('Authorization: Bearer tok_abcdef123456')).not.toContain('tok_abcdef123456')
  })

  it('masks credential-shaped values even when never registered', () => {
    // Verbose output should be safe by default, not only when we remembered to register.
    expect(redact('bearer eyJhbGciOiJIUzI1NiJ9')).toBe('bearer ****')
    expect(redact('token=abcdef1234567890')).toBe('token=****')
  })

  it('shows only the last four characters as a hint', () => {
    expect(tokenHint('abcdefghij9876')).toBe('****9876')
    expect(tokenHint('abc')).toBe('****')
  })

  it('redacts nested structures by key name while preserving shape', () => {
    const input = { user: { name: 'Ada', apiKey: 'secret_value_1234' }, items: [1, 2] }
    const out = redactValue(input)

    expect(out.user.name).toBe('Ada')
    expect(out.user.apiKey).toBe('****1234')
    expect(out.items).toEqual([1, 2])
  })

  it('leaves short values alone rather than garbling unrelated output', () => {
    registerSecret('abc')
    expect(redact('abc def')).toBe('abc def')
  })
})
