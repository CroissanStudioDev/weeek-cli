/**
 * Request shape, driven by the registry itself.
 *
 * Every one of the 153 operations is exercised against a mock server: the method, the
 * interpolated path and the headers must be exactly what the spec declares. Because the cases
 * come from the registry rather than a hand-written list, an operation added by a spec refresh
 * is covered the moment it appears.
 *
 * `openapi-msw` types its handlers with the same `paths` type generated from the spec, so a
 * handler for a path that does not exist fails to compile rather than passing quietly.
 */

import { HttpResponse, http as rawHttp } from 'msw'
import { setupServer } from 'msw/node'
import { createOpenApiHttp } from 'openapi-msw'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_BASE_URL, WeeekClient } from '../../src/core/api/client.ts'
import { OPERATIONS } from '../../src/core/api/generated/operations.ts'
import type { paths } from '../../src/core/api/generated/types.ts'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** Typed against the generated `paths`: an unknown path is a compile error. */
const http = createOpenApiHttp<paths>({ baseUrl: DEFAULT_BASE_URL })

const client = () => new WeeekClient({ token: 'tok_test_value_1234', sleep: async () => {} })

/** A plausible value for a path placeholder. */
function sampleFor(name: string): string {
  return name.toLowerCase().includes('file') ? 'file-abc' : '42'
}

describe('openapi-msw keeps mocks aligned with the spec', () => {
  it('types handlers from the generated paths', async () => {
    // If `/tm/tasks` were not in the spec, this would not compile.
    server.use(
      http.get('/tm/tasks', ({ response }) => response(200).json({ success: true, tasks: [] })),
    )

    const operation = OPERATIONS.find((op) => op.id === 'task.list')
    if (!operation) throw new Error('missing task.list')

    await expect(client().call(operation, { path: {}, query: {} })).resolves.toEqual([])
  })
})

describe('every operation sends the request the spec describes', () => {
  const cases = OPERATIONS.map((op) => [op.id, op] as const)

  it.each(cases)('%s', async (_id, operation) => {
    const pathValues: Record<string, string> = {}
    for (const param of operation.params) {
      if (param.in === 'path') pathValues[param.name] = sampleFor(param.name)
    }

    const expectedPath = operation.path.replace(
      /\{([^}]+)\}/g,
      (_, name: string) => pathValues[name] as string,
    )

    let seen: { method: string; pathname: string; auth: string | null } | undefined

    server.use(
      rawHttp.all(`${DEFAULT_BASE_URL}/*`, ({ request }) => {
        const url = new URL(request.url)
        seen = {
          method: request.method,
          pathname: url.pathname.replace('/public/v1', ''),
          auth: request.headers.get('authorization'),
        }
        if (operation.binary) return new HttpResponse(new Blob(['bytes']))
        if (operation.successStatus === 204) return new HttpResponse(null, { status: 204 })
        return HttpResponse.json(
          operation.envelopeKey
            ? { success: true, [operation.envelopeKey]: operation.responseIsArray ? [] : {} }
            : { success: true },
        )
      }),
    )

    const request = {
      path: pathValues,
      query: {},
      ...(operation.body ? { body: {} } : {}),
      ...(operation.body?.contentType === 'multipart'
        ? { files: [{ field: 'file', file: new Blob(['x']), filename: 'a.txt' }] }
        : {}),
    }

    if (operation.binary) await client().download(operation, request)
    else await client().call(operation, request)

    expect(seen?.method).toBe(operation.method)
    expect(seen?.pathname).toBe(expectedPath)
    expect(seen?.auth).toBe('Bearer tok_test_value_1234')
    // No placeholder may survive into a real request.
    expect(seen?.pathname).not.toMatch(/[{}]/)
  })
})
