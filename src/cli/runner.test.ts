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
