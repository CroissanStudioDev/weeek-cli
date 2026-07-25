import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { clearSecrets } from '../auth/redact.ts'
import {
  buildPath,
  buildQuery,
  DEFAULT_BASE_URL,
  readPageInfo,
  unwrapEnvelope,
  WeeekClient,
} from './client.ts'
import { WeeekError } from './errors.ts'
import { OPERATIONS_BY_ID, type OperationMeta } from './generated/operations.ts'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  clearSecrets()
})
afterAll(() => server.close())

function op(id: string): OperationMeta {
  const found = OPERATIONS_BY_ID.get(id)
  if (!found) throw new Error(`unknown operation ${id}`)
  return found
}

const client = (overrides: Partial<ConstructorParameters<typeof WeeekClient>[0]> = {}) =>
  new WeeekClient({ token: 'tok_secret_value_1234', sleep: async () => {}, ...overrides })

/** Awaits a rejection and returns it as a WeeekError, failing loudly if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<WeeekError> {
  try {
    await promise
  } catch (error) {
    return error as WeeekError
  }
  throw new Error('expected the call to reject, but it resolved')
}

describe('query encoding', () => {
  it('sends booleans as 0/1 rather than true/false', () => {
    // The spec types `completed` as boolean but documents 0/1. Sending true/false is accepted
    // and silently does not filter, so this is a wrong-results bug, not an error.
    expect(buildQuery(op('task.list'), { completed: true })).toBe('?completed=1')
    expect(buildQuery(op('task.list'), { completed: false })).toBe('?completed=0')
  })

  it('encodes arrays in bracket form', () => {
    const query = buildQuery(op('task.list'), { tags: ['4', '9'] })
    expect(decodeURIComponent(query)).toBe('?tags[]=4&tags[]=9')
  })

  it('omits undefined, null and empty arrays', () => {
    expect(buildQuery(op('task.list'), { search: undefined, day: null, tags: [] })).toBe('')
  })

  it('keeps zero and empty string, which are meaningful values', () => {
    expect(buildQuery(op('task.list'), { offset: 0 })).toBe('?offset=0')
  })
})

describe('path building', () => {
  it('substitutes and URL-encodes parameters', () => {
    expect(buildPath(op('task.get'), { id: 42 })).toBe('/tm/tasks/42')
    expect(buildPath(op('task.get'), { id: 'a/b' })).toBe('/tm/tasks/a%2Fb')
  })

  it('refuses to send a request with a missing path parameter', () => {
    expect(() => buildPath(op('task.get'), {})).toThrow(WeeekError)
    expect(() => buildPath(op('task.get'), {})).toThrow(/Missing path parameter "id"/)
  })
})

describe('envelope unwrapping', () => {
  it('reads the payload key the registry recorded', () => {
    expect(unwrapEnvelope(op('task.list'), { success: true, tasks: [1, 2] })).toEqual([1, 2])
    expect(unwrapEnvelope(op('task.get'), { success: true, task: { id: 1 } })).toEqual({ id: 1 })
  })

  it('returns null for mutations that document no payload', () => {
    // 77 operations answer exactly {success: true}.
    expect(unwrapEnvelope(op('task.complete'), { success: true })).toBeNull()
  })

  it('surfaces undocumented payload rather than discarding it', () => {
    // The spec under-describes responses; dropping data would be the worse failure.
    expect(unwrapEnvelope(op('task.complete'), { success: true, task: { id: 7 } })).toEqual({
      id: 7,
    })
  })

  it('never mistakes the misspelled success flag for a payload', () => {
    // One operation spells it `sucess`.
    expect(unwrapEnvelope(op('task.complete'), { sucess: true })).toBeNull()
  })

  it('reads both hasMore spellings', () => {
    expect(readPageInfo(op('task.list'), { success: true, tasks: [], hasMore: true })).toEqual({
      hasMore: true,
    })
    expect(
      readPageInfo(op('crm.status.deal.list'), { success: true, deals: [], hasMoreDeals: true }),
    ).toEqual({ hasMore: true })
  })
})

describe('requests', () => {
  it('sends the bearer token and unwraps the payload', async () => {
    let seenAuth: string | null = null
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks`, ({ request }) => {
        seenAuth = request.headers.get('authorization')
        return HttpResponse.json({ success: true, tasks: [{ id: 1 }] })
      }),
    )

    const tasks = await client().call(op('task.list'), { path: {}, query: {} })

    expect(seenAuth).toBe('Bearer tok_secret_value_1234')
    expect(tasks).toEqual([{ id: 1 }])
  })

  it('treats a documented 204 as an empty success', async () => {
    server.use(
      http.post(
        `${DEFAULT_BASE_URL}/tm/tasks/5/locations`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    )

    const result = await client().call(op('task.location.add'), {
      path: { task_id: 5 },
      query: {},
      body: { projectId: 1 },
    })
    expect(result).toBeNull()
  })

  it('posts JSON bodies with the right content type', async () => {
    let seen: { type: string | null; body: unknown } = { type: null, body: null }
    server.use(
      http.post(`${DEFAULT_BASE_URL}/tm/tasks`, async ({ request }) => {
        seen = { type: request.headers.get('content-type'), body: await request.json() }
        return HttpResponse.json({ success: true, task: { id: 9 } })
      }),
    )

    await client().call(op('task.create'), { path: {}, query: {}, body: { title: 'Hi' } })

    expect(seen.type).toBe('application/json')
    expect(seen.body).toEqual({ title: 'Hi' })
  })

  it('uploads multipart without overriding the boundary', async () => {
    let contentType: string | null = null
    let fileName: string | undefined
    server.use(
      http.post(`${DEFAULT_BASE_URL}/tm/tasks/3/attachments`, async ({ request }) => {
        contentType = request.headers.get('content-type')
        const form = await request.formData()
        fileName = (form.get('file') as File | null)?.name
        return HttpResponse.json({ success: true })
      }),
    )

    await client().call(op('task.attachment.upload'), {
      path: { task_id: 3 },
      query: {},
      files: [{ field: 'file', file: new Blob(['x']), filename: 'note.txt' }],
    })

    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(fileName).toBe('note.txt')
  })
})

describe('binary downloads', () => {
  it('returns the stream and filename instead of parsing JSON', async () => {
    server.use(
      http.get(
        `${DEFAULT_BASE_URL}/ws/attachments/abc`,
        () =>
          new HttpResponse(new Blob(['PDFDATA']), {
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="report.pdf"',
            },
          }),
      ),
    )

    const result = await client().download(op('attachment.download'), {
      path: { file_id: 'abc' },
      query: {},
    })

    expect(result.contentType).toBe('application/pdf')
    expect(result.filename).toBe('report.pdf')
    expect(await new Response(result.stream).text()).toBe('PDFDATA')
  })

  it('refuses to download an operation that returns JSON', async () => {
    await expect(client().download(op('task.list'), { path: {}, query: {} })).rejects.toThrow(
      /does not return a binary response/,
    )
  })
})

describe('errors', () => {
  it('classifies 401 as auth and points at the auth commands', async () => {
    server.use(
      http.get(`${DEFAULT_BASE_URL}/user/me`, () =>
        HttpResponse.json({ success: false, message: 'Unauthenticated' }, { status: 401 }),
      ),
    )

    const error = await rejection(client().call(op('me'), { path: {}, query: {} }))

    expect(error).toBeInstanceOf(WeeekError)
    expect(error.kind).toBe('auth')
    expect(error.message).toContain('Unauthenticated')
    expect(error.message).toContain('weeek auth login')
  })

  it('classifies 404 and 422 distinctly', async () => {
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks/1`, () => HttpResponse.json({}, { status: 404 })),
      http.post(`${DEFAULT_BASE_URL}/tm/tasks`, () =>
        HttpResponse.json({ errors: { title: ['required'] } }, { status: 422 }),
      ),
    )

    const notFound = await rejection(client().call(op('task.get'), { path: { id: 1 }, query: {} }))
    expect(notFound.kind).toBe('not-found')

    const invalid = await rejection(
      client().call(op('task.create'), { path: {}, query: {}, body: {} }),
    )
    expect(invalid.kind).toBe('validation')
    // Field errors are undocumented; we surface them rather than printing "HTTP 422".
    expect(invalid.message).toBe('title: required')
  })

  it('reads "not found" from the body code, which the HTTP status contradicts', async () => {
    // Recorded from the live API: a missing task answers 400, not 404. Trusting the status
    // would make `weeek task get <missing>` exit 2 ("bad input") instead of 4 ("not found").
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks/999999999`, () =>
        HttpResponse.json(
          { success: false, code: 1000001, message: 'Model not found' },
          { status: 400 },
        ),
      ),
    )

    const error = await rejection(
      client().call(op('task.get'), { path: { id: 999999999 }, query: {} }),
    )

    expect(error.kind).toBe('not-found')
    expect(error.status).toBe(400)
    expect(error.message).toBe('Model not found')
  })

  it('reports a missing route separately from a missing record', async () => {
    // Also live-recorded: the framework's routing 404 has no `success` flag at all.
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks/7`, () =>
        HttpResponse.json(
          { message: 'The route public/v1/tm/does-not-exist could not be found.' },
          { status: 404 },
        ),
      ),
    )

    const error = await rejection(client().call(op('task.get'), { path: { id: 7 }, query: {} }))
    expect(error.kind).toBe('not-found')
    expect(error.message).toContain('could not be found')
  })

  it('surfaces the real 422 validation shape', async () => {
    // Live-recorded: {"success":false,"errors":{"perPage":["The per page must be an integer."]}}
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks`, () =>
        HttpResponse.json(
          { success: false, errors: { perPage: ['The per page must be an integer.'] } },
          { status: 422 },
        ),
      ),
    )

    const error = await rejection(client().call(op('task.list'), { path: {}, query: {} }))
    expect(error.kind).toBe('validation')
    expect(error.message).toBe('perPage: The per page must be an integer.')
  })

  it('retries 429 and honours Retry-After', async () => {
    const sleeps: number[] = []
    let calls = 0
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks`, () => {
        calls++
        if (calls === 1) {
          return HttpResponse.json({}, { status: 429, headers: { 'retry-after': '2' } })
        }
        return HttpResponse.json({ success: true, tasks: [] })
      }),
    )

    const result = await client({ sleep: async (ms) => void sleeps.push(ms) }).call(
      op('task.list'),
      {
        path: {},
        query: {},
      },
    )

    expect(calls).toBe(2)
    expect(sleeps).toEqual([2000])
    expect(result).toEqual([])
  })

  it('gives up after maxAttempts on repeated 500s', async () => {
    let calls = 0
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks`, () => {
        calls++
        return HttpResponse.json({}, { status: 500 })
      }),
    )

    const error = await rejection(
      client({ maxAttempts: 3 }).call(op('task.list'), { path: {}, query: {} }),
    )

    expect(calls).toBe(3)
    expect(error.kind).toBe('api')
    expect(error.retryable).toBe(true)
  })

  it('does not retry a 400', async () => {
    let calls = 0
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks`, () => {
        calls++
        return HttpResponse.json({ message: 'bad' }, { status: 400 })
      }),
    )

    await client()
      .call(op('task.list'), { path: {}, query: {} })
      .catch(() => {})
    expect(calls).toBe(1)
  })
})

describe('tracing', () => {
  it('never writes the token into trace output', async () => {
    server.use(
      http.get(`${DEFAULT_BASE_URL}/user/me`, () => HttpResponse.json({ success: true, user: {} })),
    )

    const lines: string[] = []
    await client({ onTrace: (line) => lines.push(line) }).call(op('me'), { path: {}, query: {} })

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain('tok_secret_value_1234')
    expect(lines.join('\n')).toContain('GET /user/me → 200')
  })
})

describe('pagination', () => {
  it('follows hasMore for the one operation that declares pagination', async () => {
    const seen: string[] = []
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/tasks`, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url.search)
        const offset = Number(url.searchParams.get('offset'))
        return offset === 0
          ? HttpResponse.json({ success: true, tasks: [{ id: 1 }, { id: 2 }], hasMore: true })
          : HttpResponse.json({ success: true, tasks: [{ id: 3 }], hasMore: false })
      }),
    )

    const pages: unknown[][] = []
    for await (const page of client().paginate(op('task.list'), { path: {}, query: {} }, 2)) {
      pages.push(page)
    }

    expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]])
    expect(seen[0]).toContain('offset=0')
    expect(seen[1]).toContain('offset=2')
  })

  it('yields a single page for endpoints without pagination parameters', async () => {
    server.use(
      http.get(`${DEFAULT_BASE_URL}/tm/projects`, () =>
        HttpResponse.json({ success: true, projects: [{ id: 1 }] }),
      ),
    )

    const pages: unknown[][] = []
    for await (const page of client().paginate(op('project.list'), { path: {}, query: {} })) {
      pages.push(page)
    }
    expect(pages).toEqual([[{ id: 1 }]])
  })
})

describe('network failures', () => {
  it('retries then reports a network error', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    const error = await rejection(
      client({ fetch: failing as unknown as typeof fetch, maxAttempts: 2 }).call(op('task.list'), {
        path: {},
        query: {},
      }),
    )

    expect(failing).toHaveBeenCalledTimes(2)
    expect(error.kind).toBe('network')
    expect(error.retryable).toBe(true)
  })
})
