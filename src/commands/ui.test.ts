/**
 * The data the board is built from.
 *
 * `Board.test.tsx` renders fixtures, so it cannot see a wrong *request*. This does: `weeek ui`
 * originally asked `GET /tm/boards` with an empty query, and that endpoint answers 422 without
 * `projectId` — the TUI failed on first use for everyone, and every test still passed.
 */

import { describe, expect, it } from 'vitest'
import type { WeeekError } from '../core/api/errors.ts'
import { OPERATIONS_BY_ID } from '../core/api/generated/operations.ts'
import { loadBoardData } from './ui.ts'

const operation = (id: string) => {
  const found = OPERATIONS_BY_ID.get(id)
  if (!found) throw new Error(`missing operation ${id}`)
  return found
}

interface Call {
  id: string
  query: Record<string, unknown>
}

/** Records every request and answers from a fixture keyed by operation id. */
function stubClient(responses: Record<string, unknown>) {
  const calls: Call[] = []
  return {
    calls,
    client: {
      async call<T>(
        op: { id: string },
        request: { path: Record<string, string | number>; query: Record<string, unknown> },
      ): Promise<T | null> {
        calls.push({ id: op.id, query: request.query })
        return (responses[op.id] ?? null) as T | null
      },
    },
  }
}

const fixtures = {
  'project.list': [
    { id: 2, name: 'Website' },
    { id: 7, name: 'Mobile' },
  ],
  'board.list': [
    { id: 3, name: 'Roadmap', projectId: 2 },
    { id: 4, name: 'Tasks', projectId: 2 },
  ],
  'board-column.list': [
    { id: 12, name: 'To do' },
    { id: 13, name: 'Doing' },
  ],
  'task.list': [{ id: 174, title: 'Ship it', boardColumnId: 12 }],
}

describe('loading the board', () => {
  it('asks for boards with the projectId the API requires', async () => {
    const { client, calls } = stubClient(fixtures)
    await loadBoardData(client, operation, {})

    const boards = calls.find((call) => call.id === 'board.list')
    expect(boards?.query).toEqual({ projectId: 2 })
    // Projects must be fetched first — the requirement is what forces the order.
    expect(calls[0]?.id).toBe('project.list')
  })

  it('scopes columns and tasks to the chosen board', async () => {
    const { client, calls } = stubClient(fixtures)
    const data = await loadBoardData(client, operation, {})

    expect(calls.find((c) => c.id === 'board-column.list')?.query).toEqual({ boardId: 3 })
    expect(calls.find((c) => c.id === 'task.list')?.query).toEqual({ boardId: 3, projectId: 2 })
    expect(data.title).toBe('Website · Roadmap')
    expect(data.columns.map((c) => c.name)).toEqual(['To do', 'Doing'])
    expect(data.tasks).toHaveLength(1)
  })

  it('honours --project and --board', async () => {
    const { client, calls } = stubClient({
      ...fixtures,
      'board.list': [{ id: 9, name: 'Backlog', projectId: 7 }],
    })
    const data = await loadBoardData(client, operation, { project: '7', board: '9' })

    expect(calls.find((c) => c.id === 'board.list')?.query).toEqual({ projectId: 7 })
    expect(data.title).toBe('Mobile · Backlog')
  })

  it('says which project has no boards rather than rendering an empty screen', async () => {
    const { client } = stubClient({ ...fixtures, 'board.list': [] })
    const error = (await loadBoardData(client, operation, {}).catch((e) => e)) as WeeekError

    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('Website')
  })

  it('names the command to run when the requested board is not in the project', async () => {
    const { client } = stubClient(fixtures)
    const error = (await loadBoardData(client, operation, { board: '999' }).catch(
      (e) => e,
    )) as WeeekError

    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('weeek board list --project-id 2')
  })

  it('reports an empty workspace instead of throwing on undefined', async () => {
    const { client } = stubClient({ 'project.list': [] })
    const error = (await loadBoardData(client, operation, {}).catch((e) => e)) as WeeekError

    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('No projects')
  })
})
