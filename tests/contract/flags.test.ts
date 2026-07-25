/**
 * Every generated flag must be reachable and usable.
 *
 * Written after two defects of the same shape shipped unnoticed: `--priority 2` was rejected by
 * local validation because codegen stringified a numeric enum, and `--color` did not exist at
 * all on ten commands because the name collided with the global `--no-color` and the builder
 * silently skipped it. Both were invisible to the parity test — the command existed, the
 * operation was wired, only the field was unusable.
 *
 * So this sweeps the registry rather than naming commands: it asks, of every flag, whether a
 * plausible value survives the path from argv to request body.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GLOBAL_FLAGS } from '../../src/cli/global-flags.ts'
import { OPERATIONS } from '../../src/core/api/generated/operations.ts'
import { BODY_SCHEMAS } from '../../src/core/api/generated/schemas.ts'

type BodySchema = { safeParse(value: unknown): { success: boolean; error?: unknown } }

const withBody = OPERATIONS.filter((operation) => operation.body !== null)

/** What `runner.ts` hands the schema for a flag of this type, given plausible input. */
function sample(field: { type: string; enum?: readonly (string | number)[] }): unknown {
  if (field.enum) return field.enum[0]
  switch (field.type) {
    case 'integer':
    case 'number':
      return 1
    case 'boolean':
      return true
    default:
      return 'x'
  }
}

/** Does the schema complain about this field specifically, ignoring other missing ones? */
function complainsAbout(schema: BodySchema, field: string, value: unknown): boolean {
  const result = schema.safeParse({ [field]: value })
  if (result.success) return false
  const { issues } = result.error as { issues: { path: (string | number)[] }[] }
  return issues.some((issue) => issue.path[0] === field)
}

describe('no generated flag collides with a global one', () => {
  it.each(OPERATIONS.map((operation) => [operation.command.join(' '), operation] as const))(
    '%s',
    (_command, operation) => {
      for (const param of operation.params) {
        if (param.in !== 'query') continue
        expect(GLOBAL_FLAGS.has(param.cli), `--${param.cli}`).toBe(false)
      }
      for (const field of operation.body?.fields ?? []) {
        expect(GLOBAL_FLAGS.has(field.cli), `--${field.cli}`).toBe(false)
      }
    },
  )

  it('renames rather than drops, so the field stays reachable', () => {
    // `color` is the case that exists today: ten commands take it, and `--color` is ours.
    const renamed = withBody.flatMap(
      (operation) => operation.body?.fields.filter((field) => field.cli.startsWith('body-')) ?? [],
    )

    expect(renamed.length).toBeGreaterThan(0)
    for (const field of renamed) {
      expect(GLOBAL_FLAGS.has(field.name), field.name).toBe(true)
      expect(field.cli).toBe(`body-${field.name}`)
    }
  })
})

describe('every primitive body flag accepts what the CLI sends', () => {
  // Array and object fields are excluded: they take a JSON literal whose element shape cannot
  // be guessed here, and a wrong guess would report a defect that is not one.
  const cases = withBody.flatMap((operation) =>
    (operation.body?.fields ?? [])
      .filter((field) => field.type !== 'array' && field.type !== 'object')
      .map(
        (field) => [`${operation.command.join(' ')} --${field.cli}`, operation.id, field] as const,
      ),
  )

  it.each(cases)('%s', (_label, id, field) => {
    const schema = (BODY_SCHEMAS as Record<string, BodySchema | undefined>)[id]
    if (!schema) return

    expect(complainsAbout(schema, field.name, sample(field)), JSON.stringify(sample(field))).toBe(
      false,
    )
  })
})

describe('enums are discoverable', () => {
  it('carries the allowed values into the registry, not just into zod', () => {
    // Without this the only way to learn that `--win-status` takes won|lost|archived was to
    // guess wrong and read the rejection.
    const dealPatch = OPERATIONS.find((operation) => operation.id === 'crm.deal.patch')
    const winStatus = dealPatch?.body?.fields.find((field) => field.name === 'winStatus')

    expect(winStatus?.enum).toEqual(['won', 'lost', 'archived'])
  })
})

describe('a flag goes where the spec put the value', () => {
  // The previous sweeps asked whether a flag was reachable and whether its value survived
  // validation. Both said yes for `--content-type`, which the generator invented out of a
  // header parameter and then sent as `?Content-Type=…`. Reachability is not correctness of
  // destination, so this checks the destination directly, against the spec.
  const spec = JSON.parse(
    readFileSync(new URL('../../spec/weeek-openapi.json', import.meta.url), 'utf8'),
  ) as {
    paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>
  }

  function declared(operation: (typeof OPERATIONS)[number]): { name: string; in: string }[] {
    // The registry normalises `/crm/statuses{id}`; look the operation up under either form.
    const item = spec.paths[operation.path] ?? spec.paths[operation.path.replace('/{', '{')] ?? {}
    return item[operation.method.toLowerCase()]?.parameters ?? []
  }

  it.each(OPERATIONS.map((operation) => [operation.command.join(' '), operation] as const))(
    '%s',
    (_command, operation) => {
      const generated = new Set(operation.params.map((param) => param.name))

      for (const param of declared(operation)) {
        if (param.in === 'path' || param.in === 'query') {
          expect(generated.has(param.name), `dropped ${param.in} ${param.name}`).toBe(true)
        } else {
          // Headers and cookies are the client's business. A header the user must pass by hand
          // is not a filter, and one emitted as a query flag is a wrong request.
          expect(generated.has(param.name), `${param.in} ${param.name} became a flag`).toBe(false)
        }
      }
    },
  )
})

describe('multipart uploads offer --file and nothing that pretends to be it', () => {
  const multipart = OPERATIONS.filter((operation) => operation.body?.contentType === 'multipart')

  it('there are multipart operations to check', () => {
    expect(multipart.length).toBeGreaterThan(0)
  })

  it.each(multipart.map((operation) => [operation.command.join(' '), operation] as const))(
    '%s',
    (_command, operation) => {
      // The bytes of a file do not fit in argv. `--file <path...>` reads and streams them;
      // the spec's binary part must not also surface as a string flag, least of all a required
      // one, which is how `--files[] <value> (string, required)` used to read in --help.
      for (const field of operation.body?.fields ?? []) {
        expect(field.name, 'binary part offered as a string flag').not.toMatch(/^files?(\[\])?$/i)
      }
    },
  )
})
