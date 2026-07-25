/**
 * `weeek auth` — sign in, inspect and sign out.
 *
 * The token is never accepted as a flag value: a secret in argv lands in shell history and is
 * visible in `ps` to every user on the machine. Input comes from a hidden prompt, a file, or
 * stdin.
 */

import { Command } from 'commander'
import type { Output } from '../cli/output.ts'
import type { GlobalOptions } from '../cli/runner.ts'
import { WeeekError } from '../core/api/errors.ts'
import type { TokenBackend } from '../core/config.ts'

export interface CommandDeps {
  output: Output
  global: GlobalOptions
}

async function promptForToken(output: Output): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new WeeekError({
      kind: 'input',
      message:
        'No terminal available to prompt for a token. ' +
        'Pipe it in with `weeek auth login --stdin`, use --token-file <path>, or set WEEEK_TOKEN.',
    })
  }

  const { password, isCancel, cancel } = await import('@clack/prompts')
  const value = await password({
    message: 'Paste your WEEEK API token (workspace settings → API)',
    validate: (input) => (input?.trim() ? undefined : 'The token cannot be empty'),
  })

  if (isCancel(value)) {
    cancel('Cancelled.')
    throw new WeeekError({ kind: 'input', message: 'Sign-in cancelled.' })
  }

  output.note('')
  return String(value).trim()
}

export function authCommand(deps: () => CommandDeps): Command {
  const auth = new Command('auth').description('manage API tokens and profiles')

  auth
    .command('login')
    .description('store an API token for a profile')
    .option('--backend <backend>', 'where to keep the token: file or keychain', 'file')
    .option('--stdin', 'read the token from standard input')
    .action(async (options: { backend: string; stdin?: boolean }) => {
      const { output, global } = deps()
      const { readTokenFromStdin } = await import('../core/auth/resolve.ts')
      const { storeFor } = await import('../core/auth/store.ts')
      const { readConfig, writeConfig, DEFAULT_PROFILE, TokenBackend } = await import(
        '../core/config.ts'
      )

      const parsedBackend = TokenBackend.safeParse(options.backend)
      if (!parsedBackend.success) {
        throw new WeeekError({
          kind: 'input',
          message: `Unknown backend "${options.backend}". Use "file" or "keychain".`,
        })
      }
      const backend: TokenBackend = parsedBackend.data

      let token: string
      if (options.stdin) {
        token = await readTokenFromStdin()
      } else if (global.tokenFile) {
        const { readFile } = await import('node:fs/promises')
        token = (await readFile(global.tokenFile, 'utf8')).trim()
      } else {
        token = await promptForToken(output)
      }

      if (token === '') throw new WeeekError({ kind: 'input', message: 'No token was provided.' })

      const profile = global.profile ?? DEFAULT_PROFILE

      // Verify before storing — a typo caught now is much cheaper than a confusing 401 later.
      const { WeeekClient } = await import('../core/api/client.ts')
      const { OPERATIONS_BY_ID } = await import('../core/api/generated/operations.ts')
      const me = OPERATIONS_BY_ID.get('me')
      if (!me) throw new WeeekError({ kind: 'api', message: 'Missing `me` operation in registry' })

      const client = new WeeekClient({ token })
      const user = (await client.call(me, { path: {}, query: {} })) as { email?: string } | null

      await storeFor(backend).set(profile, token)

      const config = await readConfig()
      if (!config.profiles[profile]) {
        await writeConfig({
          ...config,
          profiles: { ...config.profiles, [profile]: { backend } },
        })
      }

      const { tokenHint } = await import('../core/auth/redact.ts')
      output.success(
        `Signed in as ${user?.email ?? 'unknown user'} ` +
          `(profile "${profile}", ${backend}, token ${tokenHint(token)})`,
      )
    })

  auth
    .command('status')
    .description('show which token would be used, and from where')
    .action(async () => {
      const { output, global } = deps()
      const { resolveToken } = await import('../core/auth/resolve.ts')
      const { tokenHint } = await import('../core/auth/redact.ts')
      const { configPath } = await import('../core/config.ts')

      const resolveOptions: Parameters<typeof resolveToken>[0] = {}
      if (global.profile !== undefined) resolveOptions.profile = global.profile
      if (global.tokenFile !== undefined) resolveOptions.tokenFile = global.tokenFile

      try {
        const resolved = await resolveToken(resolveOptions)
        output.data({
          profile: resolved.profile,
          source: resolved.source,
          // Only ever a hint: enough to tell two tokens apart, never enough to use one.
          token: tokenHint(resolved.token),
          configFile: configPath(),
          baseUrl: resolved.baseUrl ?? null,
        })
      } catch (error) {
        output.data({
          profile: global.profile ?? 'default',
          source: null,
          token: null,
          configFile: configPath(),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })

  auth
    .command('logout')
    .description('remove the stored token for a profile')
    .action(async () => {
      const { output, global } = deps()
      const { readConfig, DEFAULT_PROFILE, profileFrom } = await import('../core/config.ts')
      const { storeFor } = await import('../core/auth/store.ts')

      const config = await readConfig()
      const name = global.profile ?? DEFAULT_PROFILE
      const { profile } = profileFrom(config, name)

      if (!profile) {
        output.note(`No profile "${name}" to sign out of.`)
        return
      }

      await storeFor(profile.backend).delete(name)
      output.success(`Signed out of profile "${name}".`)
    })

  return auth
}
