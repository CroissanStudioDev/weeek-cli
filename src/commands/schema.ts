/**
 * `weeek schema` and `weeek api` — introspection and the escape hatch.
 *
 * `schema` exposes the same registry the command tree is built from, so wrappers, scripts and
 * agents can discover the surface at runtime instead of scraping `--help`. It costs almost
 * nothing because the registry already exists as data.
 *
 * `api` sends an arbitrary request for anything the generated commands cannot express — a
 * repair hatch, not the main road.
 */

import { Command } from 'commander'
import { WeeekError } from '../core/api/errors.ts'
import type { CommandDeps } from './auth.ts'

export function schemaCommand(deps: () => CommandDeps): Command {
  return new Command('schema')
    .description('print the command/operation registry as data')
    .option('--command <path>', 'describe a single command, e.g. "task list"')
    .action(async (options: { command?: string }) => {
      const { output } = deps()
      const { OPERATIONS } = await import('../core/api/generated/operations.ts')

      const shape = OPERATIONS.map((op) => ({
        command: op.command.join(' '),
        id: op.id,
        method: op.method,
        path: op.path,
        summary: op.summary,
        arguments: op.params.filter((p) => p.in === 'path').map((p) => p.cli),
        options: op.params
          .filter((p) => p.in === 'query')
          .map((p) => ({
            flag: `--${p.cli}`,
            type: p.type,
            required: p.required,
            // Allowed values belong here as much as in `--help`: a caller reading the registry
            // instead of scraping help text should not have to learn an enum by guessing wrong.
            ...(p.enum ? { enum: p.enum } : {}),
          })),
        bodyFields: (op.body?.fields ?? []).map((f) => ({
          flag: `--${f.cli}`,
          field: f.name,
          type: f.type,
          required: f.required,
          ...(f.enum ? { enum: f.enum } : {}),
        })),
        paginated: op.paginated,
        binary: op.binary,
        // The file part of a multipart body is not a flag in `bodyFields` — it is `--file
        // <path...>`, which reads the file. Without this marker the registry would describe an
        // upload as a body with no fields at all.
        multipart: op.body?.contentType === 'multipart',
      }))

      if (options.command) {
        const wanted = options.command.trim()
        const found = shape.find((entry) => entry.command === wanted)
        if (!found) {
          throw new WeeekError({ kind: 'input', message: `No such command: "${wanted}"` })
        }
        output.data(found)
        return
      }

      output.data(shape)
    })
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export function apiCommand(deps: () => CommandDeps): Command {
  return new Command('api')
    .description('send a raw request to any API path')
    .argument('<method>', 'GET, POST, PUT, PATCH or DELETE')
    .argument('<path>', 'path relative to the API root, e.g. /tm/tasks')
    .option('--query <pairs...>', 'query parameters as key=value')
    .option('--body <json>', 'raw JSON request body')
    .action(async (method: string, path: string, options: { query?: string[]; body?: string }) => {
      const { output, global } = deps()

      const verb = method.toUpperCase()
      if (!METHODS.has(verb)) {
        throw new WeeekError({ kind: 'input', message: `Unsupported method "${method}"` })
      }

      const query: Record<string, unknown> = {}
      for (const pair of options.query ?? []) {
        const index = pair.indexOf('=')
        if (index === -1) {
          throw new WeeekError({
            kind: 'input',
            message: `--query expects key=value, got "${pair}"`,
          })
        }
        query[pair.slice(0, index)] = pair.slice(index + 1)
      }

      let body: unknown
      if (options.body !== undefined) {
        try {
          body = JSON.parse(options.body)
        } catch (cause) {
          throw new WeeekError({ kind: 'input', message: '--body is not valid JSON', cause })
        }
      }

      // `--dry-run` describes the request instead of sending it, so it must not demand
      // credentials — the generated commands behave the same way.
      if (global.dryRun) {
        const search = new URLSearchParams(
          Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]),
        ).toString()
        output.data({
          method: verb,
          path: path.startsWith('/') ? path : `/${path}`,
          query: search ? `?${search}` : '',
          body: body ?? null,
        })
        return
      }

      const { resolveToken } = await import('../core/auth/resolve.ts')
      const { WeeekClient } = await import('../core/api/client.ts')

      const resolveOptions: Parameters<typeof resolveToken>[0] = {}
      if (global.profile !== undefined) resolveOptions.profile = global.profile
      if (global.tokenFile !== undefined) resolveOptions.tokenFile = global.tokenFile
      const auth = await resolveToken(resolveOptions)

      const baseUrl = global.baseUrl ?? auth.baseUrl
      const client = new WeeekClient({
        token: auth.token,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(global.verbose ? { onTrace: (line: string) => output.trace(line) } : {}),
      })

      // A synthetic operation: no envelope key, so the raw body comes back untouched.
      const operation = {
        id: 'api.raw',
        method: verb as 'GET',
        path: path.startsWith('/') ? path : `/${path}`,
        command: ['api'],
        summary: 'raw request',
        params: [],
        body: null,
        envelopeKey: null,
        hasMoreKey: null,
        successStatus: 200,
        binary: false,
        paginated: false,
        responseSchema: null,
        responseIsArray: false,
      } as const

      const { body: raw } = await client.callRaw(operation, {
        path: {},
        query,
        ...(body === undefined ? {} : { body }),
      })
      output.data(raw)
    })
}
