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
