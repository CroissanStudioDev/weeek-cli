#!/usr/bin/env bun
/**
 * Generates the operation registry from the vendored OpenAPI document.
 *
 * The registry is the spine of this CLI: one array of 153 plain-data records that the command
 * tree, shell completion, `weeek schema` and the parity test all read from. Coverage is
 * therefore derived from the spec and asserted by a test, not maintained by hand.
 *
 * Emits into src/core/api/generated/ (committed — installing must not require codegen):
 *   operations.ts  runtime metadata for every operation
 *   schemas.ts     zod schemas for request bodies, so bad input fails before the network
 *   types.ts       `paths` + component types via openapi-typescript
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import openapiTS, { astToString } from 'openapi-typescript'
import {
  BINARY_OPERATIONS,
  BOOLEAN_WIRE_FORMAT,
  ENVELOPE_META_KEYS,
  HAS_MORE_KEYS,
  PATH_FIXES,
  REQUIRED_QUERY_OVERRIDES,
  RESPONSE_SCHEMAS,
} from '../spec/overrides.ts'
import { flagName } from '../src/cli/global-flags.ts'
import { argName, commandFor, type HttpMethod } from '../src/cli/naming.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SPEC_PATH = resolve(ROOT, 'spec/weeek-openapi.json')
const OUT_DIR = resolve(ROOT, 'src/core/api/generated')

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

// The generator walks an untyped, hand-written OpenAPI document whose shape is exactly what
// this script exists to discover — `unknown` would mean casting at every access instead.
// This looseness stops at the generator: everything it emits is fully typed.
// biome-ignore lint/suspicious/noExplicitAny: traversing an arbitrary JSON document
type Json = Record<string, any>

const spec: Json = await Bun.file(SPEC_PATH).json()

/** DEFECT 1: `/crm/statuses{id}` is missing a slash. */
function fixPath(path: string): string {
  return PATH_FIXES[path]?.to ?? path
}

function resolveRef(node: Json | undefined): Json | undefined {
  if (!node) return undefined
  if (typeof node.$ref !== 'string') return node
  const name = node.$ref.replace('#/components/schemas/', '')
  return spec.components?.schemas?.[name]
}

// ---------------------------------------------------------------------------------------------
// Pass 1: index the document so naming can ask structural questions about sibling paths.
// ---------------------------------------------------------------------------------------------

const allPaths: string[] = []
const methodCount = new Map<string, number>()
const collectionDeletes = new Set<string>()

for (const [rawPath, item] of Object.entries(spec.paths as Json)) {
  const path = fixPath(rawPath)
  allPaths.push(path)
  const methods = Object.keys(item as Json).filter((m) =>
    (METHODS as readonly string[]).includes(m),
  )
  methodCount.set(path, methods.length)
  // A DELETE on a path whose last segment is a literal = "detach", pairing with POST "attach".
  if (methods.includes('delete') && !path.endsWith('}')) collectionDeletes.add(path)
}

// ---------------------------------------------------------------------------------------------
// Pass 2: build the registry.
// ---------------------------------------------------------------------------------------------

export interface BodyFieldMeta {
  name: string
  type: string
  required: boolean
  cli: string
  enum?: (string | number)[]
}

export interface ParamMeta {
  name: string
  in: 'path' | 'query'
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array'
  itemType?: 'string' | 'integer' | 'number' | 'boolean'
  required: boolean
  description?: string
  enum?: (string | number)[]
  /** kebab-case flag / positional name. */
  cli: string
  /** How the value must be encoded on the wire when it differs from the declared type. */
  wire?: 'numeric-bool'
}

interface OperationMeta {
  id: string
  method: HttpMethod
  path: string
  command: string[]
  summary: string
  params: ParamMeta[]
  body: {
    contentType: 'json' | 'multipart'
    required: boolean
    fields: BodyFieldMeta[]
  } | null
  envelopeKey: string | null
  hasMoreKey: string | null
  successStatus: number
  binary: boolean
  paginated: boolean
  responseSchema: string | null
  responseIsArray: boolean
}

function toKebab(s: string): string {
  return s
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

/**
 * The declared type, with nullability dropped.
 *
 * OpenAPI 3.1 allows `type: ["string", "null"]`, which this spec uses widely. The CLI cares
 * about the shape of the value, not whether null is permitted — that is zod's job.
 */
function schemaType(schema: Json | undefined): string {
  const type = schema?.type
  if (Array.isArray(type)) return (type.find((t: string) => t !== 'null') ?? 'string') as string
  return typeof type === 'string' ? type : 'string'
}

function paramType(schema: Json | undefined): ParamMeta['type'] {
  const t = schemaType(schema)
  if (t === 'integer' || t === 'number' || t === 'boolean' || t === 'array') return t
  return 'string'
}

/**
 * DEFECT 5: the payload is the single key that is not bookkeeping.
 *
 * Note the success status is not always 200 — `POST/DELETE /tm/tasks/{id}/locations` answer 204.
 * Looking only at 200 silently produced "no envelope" for those two.
 *
 * A null key is meaningful rather than unknown: 77 of the 153 operations document their response
 * as exactly `{success: true}` — mutations that return no payload at all.
 */
function envelopeOf(op: Json): {
  key: string | null
  hasMore: string | null
  isArray: boolean
  status: number
} {
  const statuses = Object.keys(op.responses ?? {})
    .map(Number)
    .filter((code) => code >= 200 && code < 300)
    .sort((a, b) => a - b)
  const status = statuses[0] ?? 200

  const schema = op.responses?.[String(status)]?.content?.['application/json']?.schema
  const props: Json | undefined = schema?.properties
  if (!props) return { key: null, hasMore: null, isArray: false, status }

  const hasMore = HAS_MORE_KEYS.find((k) => k in props) ?? null
  const payloadKey = Object.keys(props).find((k) => !ENVELOPE_META_KEYS.has(k)) ?? null
  const isArray = payloadKey ? props[payloadKey]?.type === 'array' : false
  return { key: payloadKey, hasMore, isArray, status }
}

/**
 * Sort parameters document descending order as a `-` prefix ("prepend a minus sign to the
 * parameter, for example `-name`") while their enum lists only the ascending forms. Commander
 * validates against that enum, so `--sort-by -created` — the documented way to sort newest
 * first — was rejected outright, and descending sort was reachable only through `weeek api`.
 *
 * The prefixed forms are added to the enum itself rather than special-cased in the CLI, so
 * `--help`, shell completion and `weeek schema --json` all agree on what is accepted.
 */
function withDescendingVariants(
  values: (string | number)[],
  description: string | undefined,
): (string | number)[] {
  if (!/minus sign/i.test(description ?? '')) return values
  return [...values, ...values.map((value) => `-${value}`)]
}

const operations: OperationMeta[] = []

for (const [rawPath, item] of Object.entries(spec.paths as Json)) {
  const path = fixPath(rawPath)

  for (const method of METHODS) {
    const op: Json | undefined = (item as Json)[method]
    if (!op) continue

    const httpMethod = method.toUpperCase() as HttpMethod
    const command = commandFor(httpMethod, path, allPaths, methodCount, collectionDeletes)
    const key = `${httpMethod} ${path}`

    const params: ParamMeta[] = []
    for (const raw of (op.parameters ?? []) as Json[]) {
      const p = resolveRef(raw) ?? raw
      const schema = resolveRef(p.schema) ?? p.schema
      const where = p.in === 'path' ? 'path' : 'query'
      const meta: ParamMeta = {
        name: p.name,
        in: where,
        type: paramType(schema),
        required:
          p.required === true ||
          where === 'path' ||
          (REQUIRED_QUERY_OVERRIDES[key]?.params.includes(p.name) ?? false),
        cli: where === 'path' ? argName(p.name) : flagName(toKebab(p.name), 'query'),
      }
      if (schema?.items?.type) meta.itemType = schema.items.type
      if (p.description) meta.description = p.description
      if (schema?.enum) meta.enum = withDescendingVariants(schema.enum, p.description)
      // The API takes 0/1 rather than true/false — see overrides: BOOLEAN_WIRE_FORMAT.
      if (meta.type === 'boolean' && BOOLEAN_WIRE_FORMAT.style === 'numeric') {
        meta.wire = 'numeric-bool'
      }
      params.push(meta)
    }

    // Path parameters are not always declared in `parameters` — recover them from the template.
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1] as string
      if (params.some((p) => p.in === 'path' && p.name === name)) continue
      params.push({ name, in: 'path', type: 'string', required: true, cli: argName(name) })
    }

    let body: OperationMeta['body'] = null
    const content: Json | undefined = op.requestBody?.content
    if (content) {
      const isMultipart = Object.keys(content).some((c) => c.includes('multipart'))
      const schema = resolveRef(
        content['application/json']?.schema ?? Object.values(content)[0]?.schema,
      )
      const requiredFields: string[] = schema?.required ?? []
      body = {
        contentType: isMultipart ? 'multipart' : 'json',
        required: op.requestBody.required === true,
        // Types travel with each field so the CLI knows which flags must be parsed as JSON:
        // an array field handed a bare string is rejected by zod before it ever ships.
        fields: Object.entries((schema?.properties ?? {}) as Json).map(([name, sub]) => {
          const property = (resolveRef(sub as Json) ?? sub) as Json
          const field: BodyFieldMeta = {
            name,
            type: schemaType(property),
            required: requiredFields.includes(name),
            // Renamed when the API's own name is a CLI flag — see global-flags.ts. Renaming
            // here rather than in the command builder keeps `weeek schema --json`, shell
            // completion and `--help` naming the same flag.
            cli: flagName(toKebab(name), 'body'),
          }
          // Without this the only hint that `--win-status` takes won|lost|archived was the
          // rejection message from zod, and only after a wrong guess.
          if (Array.isArray(property.enum) && property.enum.length > 0) {
            field.enum = property.enum as (string | number)[]
          }
          return field
        }),
      }
    }

    const envelope = envelopeOf(op)
    const paramNames = new Set(params.map((p) => p.name))
    const binary = BINARY_OPERATIONS.has(key)

    operations.push({
      id: command.join('.'),
      method: httpMethod,
      path,
      command,
      summary: op.summary ?? '',
      params,
      body,
      // A binary response has no envelope by construction — leaving a key here would let a
      // reasonable client unwrap file bytes as JSON and corrupt the download.
      envelopeKey: binary ? null : envelope.key,
      hasMoreKey: binary ? null : envelope.hasMore,
      successStatus: envelope.status,
      binary,
      // DEFECT 6: only where the spec actually declares the parameters.
      paginated: paramNames.has('perPage') && paramNames.has('offset'),
      responseSchema: RESPONSE_SCHEMAS[key] ?? null,
      responseIsArray: envelope.isArray,
    })
  }
}

operations.sort((a, b) => a.id.localeCompare(b.id))

// ---------------------------------------------------------------------------------------------
// Sanity checks — a broken generator must fail here, not surface as missing commands later.
// ---------------------------------------------------------------------------------------------

const ids = new Map<string, OperationMeta[]>()
for (const op of operations) {
  const list = ids.get(op.id) ?? []
  list.push(op)
  ids.set(op.id, list)
}
const collisions = [...ids].filter(([, v]) => v.length > 1)
if (collisions.length > 0) {
  console.error('Command name collisions — two operations would share one command:')
  for (const [id, v] of collisions) {
    console.error(`  ${id}`)
    for (const op of v) console.error(`      ${op.method} ${op.path}`)
  }
  process.exit(1)
}
if (operations.some((op) => op.path.includes('}{') || /\w\{/.test(op.path))) {
  console.error('A malformed path survived PATH_FIXES:')
  for (const bad of operations.filter((o) => /\w\{/.test(o.path))) console.error(`  ${bad.path}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------------------------

const BANNER = `// GENERATED by scripts/gen.ts from spec/weeek-openapi.json — do not edit.
// Run \`bun run gen\` to regenerate. CI asserts this file matches the spec.
`

const operationsFile = `${BANNER}
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ParamMeta {
  readonly name: string
  readonly in: 'path' | 'query'
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'array'
  readonly itemType?: 'string' | 'integer' | 'number' | 'boolean'
  readonly required: boolean
  readonly description?: string
  readonly enum?: readonly (string | number)[]
  /** kebab-case flag or positional argument name */
  readonly cli: string
  /**
   * Wire encoding when it differs from the declared type.
   * 'numeric-bool': send 0/1 — this API does not honour true/false.
   */
  readonly wire?: 'numeric-bool'
}

export interface OperationMeta {
  /** Stable dotted id, identical to the command path: 'task.watcher.add' */
  readonly id: string
  readonly method: HttpMethod
  /** Path template with {placeholders}, after spec corrections */
  readonly path: string
  /** Command path: ['task', 'watcher', 'add'] */
  readonly command: readonly string[]
  readonly summary: string
  readonly params: readonly ParamMeta[]
  readonly body: {
    readonly contentType: 'json' | 'multipart'
    readonly required: boolean
    readonly fields: readonly {
      readonly name: string
      /** JSON Schema type: array/object fields arrive as JSON on the command line */
      readonly type: string
      readonly required: boolean
      /** kebab-case flag, prefixed with "body-" when the API's own name is a CLI flag */
      readonly cli: string
      /** Values the spec allows, surfaced in --help so they are discoverable */
      readonly enum?: readonly (string | number)[]
    }[]
  } | null
  /**
   * Key holding the payload inside the response envelope.
   * null means the operation documents no payload — 77 mutations answer exactly
   * {success: true} — or the response is binary.
   */
  readonly envelopeKey: string | null
  /** Key signalling another page ('hasMore' / 'hasMoreDeals') */
  readonly hasMoreKey: string | null
  /** Documented success status; not always 200 (task locations answer 204) */
  readonly successStatus: number
  /** Returns file bytes rather than JSON */
  readonly binary: boolean
  /** Declares perPage + offset, so --all-pages is offered */
  readonly paginated: boolean
  /** Component schema describing the payload, where known */
  readonly responseSchema: string | null
  readonly responseIsArray: boolean
}

export const OPERATIONS: readonly OperationMeta[] = ${JSON.stringify(operations, null, 2)} as const

export const OPERATIONS_BY_ID: ReadonlyMap<string, OperationMeta> = new Map(
  OPERATIONS.map((op) => [op.id, op]),
)

/** Top-level command namespaces, in help order. */
export const NAMESPACES: readonly string[] = ${JSON.stringify(
  [...new Set(operations.map((op) => op.command[0] as string))].sort(),
)}
`

// --- zod schemas for request bodies ---------------------------------------------------------

function zodFor(schema: Json | undefined, depth = 0): string {
  const s = resolveRef(schema)
  if (!s || depth > 6) return 'z.unknown()'

  // `type: ["string", "null"]` is used throughout this spec; without unwrapping it, every
  // nullable field would silently degrade to z.unknown() and validate nothing.
  const nullable = Array.isArray(s.type) && s.type.includes('null')

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    // Numeric enums must stay numeric. Stringifying them (`priority: enum [0,1,2,3]` becoming
    // z.enum(["0",…])) contradicted the field's declared `integer` type, which is what the CLI
    // coerces the flag to — so `--priority 2` failed validation and the field was reachable
    // only through `--body`.
    const numeric = s.enum.every((member) => typeof member === 'number')
    const inner = numeric
      ? `z.union([${s.enum.map((member) => `z.literal(${member})`).join(', ')}])`
      : `z.enum(${JSON.stringify(s.enum.map(String))})`
    return nullable ? `${inner}.nullable()` : inner
  }

  const inner = zodForType(schemaType(s), s, depth)
  return nullable ? `${inner}.nullable()` : inner
}

function zodForType(type: string, s: Json, depth: number): string {
  switch (type) {
    case 'string':
      return s.format === 'date-time' ? 'z.string()' : 'z.string()'
    case 'integer':
      return 'z.number().int()'
    case 'number':
      return 'z.number()'
    case 'boolean':
      return 'z.boolean()'
    case 'array':
      return `z.array(${zodFor(s.items, depth + 1)})`
    case 'object': {
      if (!s.properties) return 'z.record(z.string(), z.unknown())'
      const required: string[] = s.required ?? []
      const entries = Object.entries(s.properties as Json).map(([name, sub]) => {
        const inner = zodFor(sub as Json, depth + 1)
        const optional = required.includes(name) ? '' : '.optional()'
        return `    ${JSON.stringify(name)}: ${inner}${optional},`
      })
      return `z.object({\n${entries.join('\n')}\n  })`
    }
    default:
      return 'z.unknown()'
  }
}

const bodyEntries: string[] = []
for (const [rawPath, item] of Object.entries(spec.paths as Json)) {
  const path = fixPath(rawPath)
  for (const method of METHODS) {
    const op: Json | undefined = (item as Json)[method]
    const schema = op?.requestBody?.content?.['application/json']?.schema
    if (!schema) continue
    const id = commandFor(
      method.toUpperCase() as HttpMethod,
      path,
      allPaths,
      methodCount,
      collectionDeletes,
    ).join('.')
    bodyEntries.push(`  ${JSON.stringify(id)}: ${zodFor(schema)},`)
  }
}

const schemasFile = `${BANNER}
import { z } from 'zod'

/**
 * Request body schemas, keyed by operation id.
 *
 * Validating here means bad input fails with a readable message instead of a bare 422 from an
 * API whose error bodies are undocumented (overrides: DEFECT 4).
 */
export const BODY_SCHEMAS = {
${bodyEntries.join('\n')}
} as const satisfies Record<string, z.ZodType>

export type BodySchemaId = keyof typeof BODY_SCHEMAS
`

// --- types via openapi-typescript -------------------------------------------------------------

const normalisedSpec = JSON.parse(JSON.stringify(spec))
for (const [from, fix] of Object.entries(PATH_FIXES)) {
  if (normalisedSpec.paths[from]) {
    normalisedSpec.paths[fix.to] = normalisedSpec.paths[from]
    delete normalisedSpec.paths[from]
  }
}

const typesAst = await openapiTS(normalisedSpec, { alphabetize: true })
const typesFile = `${BANNER}\n${astToString(typesAst)}`

await writeFile(resolve(OUT_DIR, 'operations.ts'), operationsFile)
await writeFile(resolve(OUT_DIR, 'schemas.ts'), schemasFile)
await writeFile(resolve(OUT_DIR, 'types.ts'), typesFile)

console.info(`operations: ${operations.length}`)
console.info(`namespaces: ${[...new Set(operations.map((op) => op.command[0]))].length}`)
console.info(`body schemas: ${bodyEntries.length}`)
console.info(`binary ops: ${operations.filter((o) => o.binary).length}`)
console.info(`paginated ops: ${operations.filter((o) => o.paginated).length}`)
console.info(`written to ${OUT_DIR}`)
