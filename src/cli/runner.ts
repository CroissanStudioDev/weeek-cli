/**
 * Executes a registry command: turns parsed flags into a request, runs it, prints the result.
 *
 * Everything expensive — the client, zod schemas, file system — is imported at call time so
 * `weeek --help` does not pay for them.
 */

import {
  PAGINATOR_FLAG,
  SILENTLY_IGNORED_BODY_FIELDS,
  SOFT_DELETE_OPERATIONS,
} from '../../spec/overrides.ts'
import { WeeekError } from '../core/api/errors.ts'
import type { OperationMeta } from '../core/api/generated/operations.ts'
import type { Output } from './output.ts'
import type { CommandContext } from './registry.ts'

export interface GlobalOptions {
  profile?: string
  tokenFile?: string
  baseUrl?: string
  verbose?: boolean
  quiet?: boolean
  yes?: boolean
  dryRun?: boolean
  /** Bypass local zod validation when the reconstructed spec is stricter than the real API. */
  noValidate?: boolean
  /** Commander maps `--no-env-file` to `envFile: false`; undefined means "look for it". */
  envFile?: boolean
}

/**
 * The one place that translates global flags into token-resolution options.
 *
 * Every command that needs credentials used to build this object itself, and `doctor` quietly
 * forgot `--token-file` — it reported "no API token" to someone who had just passed one. A
 * shared builder makes that class of drift impossible: a new field is threaded once.
 */
export function resolveOptionsFrom(global: GlobalOptions): {
  profile?: string
  tokenFile?: string
  useEnvFile?: boolean
} {
  const options: { profile?: string; tokenFile?: string; useEnvFile?: boolean } = {}
  if (global.profile !== undefined) options.profile = global.profile
  if (global.tokenFile !== undefined) options.tokenFile = global.tokenFile
  if (global.envFile === false) options.useEnvFile = false
  return options
}

/** Commander camel-cases flags; this maps a spec parameter name back to its parsed key. */
function optionKey(cli: string): string {
  return cli.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

export function collectQuery(
  operation: OperationMeta,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const query: Record<string, unknown> = {}
  for (const param of operation.params) {
    if (param.in !== 'query') continue
    const value = options[optionKey(param.cli)]
    if (value === undefined) continue
    query[param.name] = param.type === 'integer' || param.type === 'number' ? Number(value) : value
  }
  return query
}

/**
 * Reports required query parameters the user did not supply.
 *
 * Without this the request goes out and the API answers
 * `422 {"message":"The field is required.","errors":{"projectId":[…]}}` — true, but it names a
 * wire parameter rather than the flag to type, and it costs a round trip. Two of the fourteen
 * argument-free list endpoints (`board list`, `board-column list`) hit this on every first use.
 */
export function missingRequiredQuery(
  operation: OperationMeta,
  query: Record<string, unknown>,
): string[] {
  return operation.params
    .filter((param) => param.in === 'query' && param.required && query[param.name] === undefined)
    .map((param) => `--${param.cli}`)
}

export function collectPath(
  operation: OperationMeta,
  args: string[],
): Record<string, string | number> {
  const pathParams = operation.params.filter((p) => p.in === 'path')
  const values: Record<string, string | number> = {}
  pathParams.forEach((param, index) => {
    const raw = args[index]
    if (raw !== undefined) values[param.name] = raw
  })
  return values
}

/**
 * Builds the request body from the flattened field flags, then merges `--body` JSON over them.
 *
 * `--body` wins because it is the escape hatch for anything the flags cannot express (nested
 * objects, arrays of objects), and it would be surprising for a flag to override the explicit
 * JSON the user handed us.
 */
export function collectBody(
  operation: OperationMeta,
  options: Record<string, unknown>,
): unknown | undefined {
  if (!operation.body) return undefined

  const body: Record<string, unknown> = {}
  for (const field of operation.body.fields) {
    const value = options[optionKey(field.cli)]
    if (value === undefined) continue

    // Array/object fields cannot be expressed as a bare flag value, so they are taken as JSON.
    // Without this the value arrives as a string and zod rejects it before the request ships.
    if ((field.type === 'array' || field.type === 'object') && typeof value === 'string') {
      try {
        body[field.name] = JSON.parse(value)
      } catch (cause) {
        throw new WeeekError({
          kind: 'input',
          message: `--${field.cli} expects JSON (${field.type}), got: ${value}`,
          cause,
        })
      }
      continue
    }

    if (field.type === 'integer' || field.type === 'number') {
      const numeric = Number(value)
      body[field.name] = Number.isNaN(numeric) ? value : numeric
      continue
    }

    if (field.type === 'boolean' && typeof value === 'string') {
      body[field.name] = value !== 'false' && value !== '0'
      continue
    }

    body[field.name] = value
  }

  const raw = options.body
  if (typeof raw === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new WeeekError({
        kind: 'input',
        message: `--body is not valid JSON: ${(cause as Error).message}`,
        cause,
      })
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(body, parsed)
    } else {
      return parsed
    }
  }

  return Object.keys(body).length > 0 ? body : undefined
}

/**
 * Validates the body against the generated zod schema.
 *
 * Worth doing locally because the API documents no error schema at all: without this, a typo
 * comes back as an opaque 422 (overrides: DEFECT 4).
 */
async function validateBody(
  operation: OperationMeta,
  body: unknown,
  skip = false,
): Promise<unknown> {
  if (body === undefined) return undefined
  // The spec is reconstructed from a docs bundle and is demonstrably imprecise, so a schema
  // that is stricter than the real API must not be able to block a legitimate request.
  if (skip) return body

  const { BODY_SCHEMAS } = await import('../core/api/generated/schemas.ts')
  const schema = (BODY_SCHEMAS as Record<string, { safeParse(v: unknown): unknown }>)[operation.id]
  if (!schema) return body

  const result = schema.safeParse(body) as {
    success: boolean
    data?: unknown
    error?: { issues: { path: PropertyKey[]; message: string }[] }
  }
  if (result.success) return body

  const issues = (result.error?.issues ?? [])
    .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
    .join('; ')
  throw new WeeekError({
    kind: 'input',
    message: `Invalid request body for \`${operation.command.join(' ')}\`: ${issues}`,
  })
}

export interface RunDeps {
  output: Output
  global: GlobalOptions
  /** Prompts for destructive confirmation; must never be called without a TTY. */
  confirm: (question: string) => Promise<boolean>
}

/**
 * Warns when a request carries a field the API is known to accept and discard.
 *
 * A 200 with no effect is the worst kind of failure: nothing to read, nothing to search for.
 * The field is still sent — the table records what the API does today, not a rule the CLI
 * wants to enforce — and the warning goes to stderr, so piped output is unaffected.
 */
function warnAboutIgnoredFields(operation: OperationMeta, body: unknown, output: Output): void {
  if (!body || typeof body !== 'object') return
  const fields = body as Record<string, unknown>

  const known = SILENTLY_IGNORED_BODY_FIELDS[operation.id]
  if (!known) return

  const present = known.fields.filter((field) => field in fields)
  if (present.length === 0) return

  output.warn(
    `${operation.command.join(' ')}: ${present.map((f) => `\`${f}\``).join(', ')} — ${known.note}.`,
  )
}

/**
 * Says out loud that a delete was a move to the trash.
 *
 * Without this the natural check — fetch the id again — answers 200 with the record, and the
 * reasonable conclusion is that the delete failed. It did not; the record is flagged and
 * hidden from the plain listing. Pointing at the check that actually works costs one line on
 * stderr and saves the same confusion every time.
 */
function noteSoftDelete(operation: OperationMeta, output: Output): void {
  const known = SOFT_DELETE_OPERATIONS[operation.id]
  if (!known) return

  output.note(known.note)
}

export async function runOperation(context: CommandContext, deps: RunDeps): Promise<void> {
  const { operation, args, options } = context
  const { output, global } = deps

  const pathValues = collectPath(operation, args)
  const query = collectQuery(operation, options)

  // Checked before `--dry-run` prints anything: a dry run that describes an unsendable request
  // is worse than no dry run. `--no-validate` skips it, like the body check, because the
  // reconstructed spec can be stricter than the API.
  if (!global.noValidate) {
    const missing = missingRequiredQuery(operation, query)
    if (missing.length > 0) {
      throw new WeeekError({
        kind: 'input',
        message:
          `\`weeek ${operation.command.join(' ')}\` needs ${missing.join(', ')}. ` +
          `See \`weeek ${operation.command.join(' ')} --help\`.`,
      })
    }
  }

  const body = await validateBody(operation, collectBody(operation, options), global.noValidate)
  warnAboutIgnoredFields(operation, body, output)

  if (global.dryRun) {
    const { buildPath, buildQuery } = await import('../core/api/client.ts')
    output.data({
      method: operation.method,
      path: buildPath(operation, pathValues),
      query: buildQuery(operation, query),
      body: body ?? null,
    })
    return
  }

  if (operation.method === 'DELETE' && !global.yes) {
    const target = args.length > 0 ? ` ${args.join(' ')}` : ''
    const confirmed = await deps.confirm(
      `Delete ${operation.command.slice(0, -1).join(' ')}${target}?`,
    )
    if (!confirmed) {
      output.note('Cancelled.')
      return
    }
  }

  const { resolveToken } = await import('../core/auth/resolve.ts')
  const { WeeekClient } = await import('../core/api/client.ts')

  const auth = await resolveToken(resolveOptionsFrom(global))

  const baseUrl = global.baseUrl ?? auth.baseUrl
  const client = new WeeekClient({
    token: auth.token,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(global.verbose ? { onTrace: (line: string) => output.trace(line) } : {}),
  })

  const files = await collectFiles(options)
  const request = {
    path: pathValues,
    query,
    ...(body === undefined ? {} : { body }),
    ...(files ? { files } : {}),
  }

  if (operation.binary) {
    await writeBinary(client, operation, request, options, output)
    return
  }

  if (operation.paginated && options[optionKey(PAGINATOR_FLAG)] === true) {
    const all: unknown[] = []
    for await (const page of client.paginate(operation, request)) all.push(...page)
    output.data(all)
    return
  }

  const result = await client.call(operation, request)
  output.data(result)
  noteSoftDelete(operation, output)
}

async function collectFiles(
  options: Record<string, unknown>,
): Promise<{ field: string; file: Blob; filename: string }[] | undefined> {
  const paths = options.file
  if (!Array.isArray(paths) || paths.length === 0) return undefined

  const { readFile } = await import('node:fs/promises')
  const { basename } = await import('node:path')

  return Promise.all(
    paths.map(async (path: string) => ({
      field: 'file',
      file: new Blob([await readFile(path)]),
      filename: basename(path),
    })),
  )
}

/**
 * Attachments return file bytes. They bypass the formatters entirely — piping a PDF through
 * a JSON encoder would corrupt it.
 */
async function writeBinary(
  client: import('../core/api/client.ts').WeeekClient,
  operation: OperationMeta,
  request: import('../core/api/client.ts').RequestOptions,
  options: Record<string, unknown>,
  output: Output,
): Promise<void> {
  const { stream, filename } = await client.download(operation, request)
  if (!stream) throw new WeeekError({ kind: 'api', message: 'The response had no body' })

  const target = options.outputFile
  if (typeof target === 'string') {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(target, Buffer.from(await new Response(stream).arrayBuffer()))
    output.success(`Saved to ${target}`)
    return
  }

  if (process.stdout.isTTY) {
    output.warn(
      `This is binary data${filename ? ` (${filename})` : ''}. ` +
        'Use --output-file <path>, or pipe it somewhere.',
    )
  }
  const { Readable } = await import('node:stream')
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])
      .pipe(process.stdout)
      .on('finish', resolve)
      .on('error', reject)
  })
}
