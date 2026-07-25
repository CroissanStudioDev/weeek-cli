/**
 * `weeek doctor` — environment diagnostics.
 *
 * Must work **without** authentication and report its absence rather than failing: the most
 * common reason to run it is that something about auth is wrong, and a diagnostic that needs
 * the thing it diagnoses is useless.
 */

import { Command } from 'commander'
import type { CommandDeps } from './auth.ts'

interface Check {
  name: string
  ok: boolean
  detail: string
}

export function doctorCommand(deps: () => CommandDeps): Command {
  return new Command('doctor')
    .description('check configuration, credentials and API reachability')
    .action(async () => {
      const { output, global } = deps()
      const checks: Check[] = []

      const { platform, release } = await import('node:os')
      checks.push({
        name: 'runtime',
        ok: true,
        detail: `node ${process.version} on ${platform()} ${release()}`,
      })

      const { configPath, configDir } = await import('../core/config.ts')
      const { stat } = await import('node:fs/promises')
      const path = configPath()

      let mode: number | null = null
      try {
        mode = (await stat(path)).mode & 0o777
      } catch {
        mode = null
      }

      checks.push({
        name: 'config',
        ok: true,
        detail:
          mode === null
            ? `no config file yet (${configDir()})`
            : `${path} mode ${mode.toString(8)}`,
      })

      if (mode !== null && (mode & 0o077) !== 0 && platform() !== 'win32') {
        checks.push({
          name: 'config permissions',
          ok: false,
          detail: `${path} is readable by other users — run: chmod 600 ${path}`,
        })
      }

      // Auth is reported, never required.
      const { resolveToken } = await import('../core/auth/resolve.ts')
      const { tokenHint } = await import('../core/auth/redact.ts')
      const resolveOptions: Parameters<typeof resolveToken>[0] = {}
      if (global.profile !== undefined) resolveOptions.profile = global.profile
      // `--token-file` has to be forwarded like every other command forwards it. Without it
      // `doctor` reported "no API token" to a user who had just passed one, and skipped the
      // API check on top — the one command whose whole job is to describe the real state.
      if (global.tokenFile !== undefined) resolveOptions.tokenFile = global.tokenFile

      let token: string | undefined
      try {
        const resolved = await resolveToken(resolveOptions)
        token = resolved.token
        checks.push({
          name: 'credentials',
          ok: true,
          detail: `${tokenHint(resolved.token)} from ${resolved.source} (profile "${resolved.profile}")`,
        })
      } catch (error) {
        checks.push({
          name: 'credentials',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }

      const { DEFAULT_BASE_URL, WeeekClient } = await import('../core/api/client.ts')
      const baseUrl = global.baseUrl ?? DEFAULT_BASE_URL

      const { OPERATIONS, OPERATIONS_BY_ID } = await import('../core/api/generated/operations.ts')
      const me = OPERATIONS_BY_ID.get('me')

      if (token && me) {
        try {
          const client = new WeeekClient({ token, baseUrl, maxAttempts: 1 })
          const user = (await client.call(me, { path: {}, query: {} })) as {
            email?: string
          } | null
          checks.push({
            name: 'api',
            ok: true,
            detail: `${baseUrl} reachable as ${user?.email ?? '?'}`,
          })
        } catch (error) {
          checks.push({
            name: 'api',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      } else {
        checks.push({ name: 'api', ok: false, detail: 'skipped — no credentials' })
      }

      checks.push({
        name: 'registry',
        ok: OPERATIONS.length === 153,
        detail: `${OPERATIONS.length} operations`,
      })

      // Diagnostics are commentary about the environment, not a data payload someone pipes into
      // `jq` — in table mode they belong on stderr, and they go through Output so that redaction
      // and colour rules apply to them like everything else.
      if (output.format === 'table') {
        for (const check of checks) {
          const line = `${check.name.padEnd(20)} ${check.detail}`
          if (check.ok) output.success(line)
          else output.error(line)
        }
        return
      }

      output.data({ ok: checks.every((c) => c.ok), checks })
    })
}
