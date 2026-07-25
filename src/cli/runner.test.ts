/**
 * Turning flags into a request.
 *
 * The cases here are the ones that cost a wasted round trip or produce a silently wrong result,
 * both recorded against the live API: a required query parameter the user did not pass, and the
 * numeric encoding of booleans.
 */

import { describe, expect, it } from 'vitest'
import { OPERATIONS_BY_ID } from '../core/api/generated/operations.ts'
import { collectQuery, missingRequiredQuery } from './runner.ts'

function op(id: string) {
  const operation = OPERATIONS_BY_ID.get(id)
  if (!operation) throw new Error(`missing operation ${id}`)
  return operation
}

describe('required query parameters', () => {
  it('names the flag to type, not the wire parameter', () => {
    // `GET /tm/boards` declares projectId as required; the API answers
    // {"message":"The field is required."} — true, but it does not say which flag to add.
    const boards = op('board.list')
    expect(missingRequiredQuery(boards, {})).toEqual(['--project-id'])
  })

  it('is satisfied once the value is present', () => {
    const boards = op('board.list')
    const query = collectQuery(boards, { projectId: '4' })
    expect(query).toEqual({ projectId: 4 })
    expect(missingRequiredQuery(boards, query)).toEqual([])
  })

  it('does not invent requirements for optional filters', () => {
    // GET /tm/tasks takes many filters and requires none of them.
    expect(missingRequiredQuery(op('task.list'), {})).toEqual([])
  })

  it('covers every operation that declares one', () => {
    // A guard on the shape of the registry: if a spec refresh adds a required filter, the
    // corresponding command starts checking it without anyone editing this file.
    const required = [...OPERATIONS_BY_ID.values()].filter((operation) =>
      operation.params.some((param) => param.in === 'query' && param.required),
    )
    expect(required.length).toBeGreaterThan(0)
    for (const operation of required) {
      expect(missingRequiredQuery(operation, {}).length, operation.id).toBeGreaterThan(0)
    }
  })
})

describe('query collection', () => {
  it('passes booleans through for the client to encode as 0/1', () => {
    const query = collectQuery(op('task.list'), { completed: true })
    expect(query).toEqual({ completed: true })
  })

  it('converts numeric parameters, since Commander hands over strings', () => {
    const query = collectQuery(op('task.list'), { projectId: '4', perPage: '50' })
    expect(query).toEqual({ projectId: 4, perPage: 50 })
  })

  it('omits what the user did not pass rather than sending empty values', () => {
    expect(collectQuery(op('task.list'), {})).toEqual({})
  })
})

describe('enums the spec only half-declares', () => {
  it('accepts the documented `-` prefix for descending sort', () => {
    // The description says "prepend a minus sign … for example `-name`" while the enum lists
    // only the ascending forms. Commander validates against the enum, so descending sort used
    // to be rejected outright — reachable only through `weeek api`.
    const sortBy = op('task.list').params.find((param) => param.name === 'sortBy')

    expect(sortBy?.enum).toContain('created')
    expect(sortBy?.enum).toContain('-created')
  })

  it('prefixes the sort enums and nothing else', () => {
    // Partitioned over the whole registry, so a spec refresh cannot quietly add a fifth sort
    // parameter that keeps the old behaviour — or grant the prefix to a filter that rejects it.
    // As of the shipped spec every enum-bearing query parameter happens to be a sort parameter
    // (tasks, contacts, organizations, deals), so the second group is legitimately empty.
    const withEnum = [...OPERATIONS_BY_ID.values()].flatMap((operation) =>
      operation.params.filter((param) => param.enum !== undefined),
    )
    const documented = withEnum.filter((param) => /minus sign/i.test(param.description ?? ''))

    expect(documented.length).toBe(4)
    for (const param of withEnum) {
      const prefixed = param.enum?.some((value) => String(value).startsWith('-')) ?? false
      expect(prefixed, param.name).toBe(documented.includes(param))
    }
  })

  it('keeps numeric enums numeric so the flag is usable at all', async () => {
    // `priority` is `enum: [0,1,2,3]` on an integer field. Generating z.enum(["0",…]) from it
    // contradicted the coercion the CLI applies to an integer flag, and `--priority 2` failed
    // local validation — the field could only be set through `--body`.
    const { BODY_SCHEMAS } = await import('../core/api/generated/schemas.ts')
    const schema = BODY_SCHEMAS['task.update']

    expect(schema?.safeParse({ priority: 2 }).success).toBe(true)
    expect(schema?.safeParse({ priority: '2' }).success).toBe(false)
    expect(schema?.safeParse({ priority: 9 }).success).toBe(false)
  })
})
