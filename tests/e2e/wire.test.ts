/**
 * The built CLI against a stub API: what actually goes on the wire.
 *
 * `tests/contract/request-shape.test.ts` already drives every operation through the client and
 * checks method, path and auth header. It cannot check the half that only exists in a process:
 * argv → flags → request body. A dry run cannot check it either — it prints from the same
 * assembly code it is supposed to prove, and never opens a socket.
 *
 * So this spawns the real `dist/weeek.js` with `--base-url` pointed at a local server and
 * asserts what that server received. Everything here was previously "verified by dry run" or
 * not verified at all: multipart assembly, binary downloads, pagination following a second
 * page, retry after a 429, the mapping from HTTP status to exit code, and the promise that a
 * refused confirmation sends nothing.
 *
 * Spawning is asynchronous on purpose. `spawnSync` blocks this process's event loop, so the
 * stub server never gets to answer and every request times out.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPERATIONS } from '../../src/core/api/generated/operations.ts'

const CLI = resolve(import.meta.dirname, '../../dist/weeek.js')
const built = existsSync(CLI)

const TOKEN = 'tok_stub_value_1234'

interface Seen {
  method: string
  pathname: string
  search: string
  headers: Record<string, string | undefined>
  body: Buffer
}

type Reply = (request: Seen, response: ServerResponse) => void

/** Answers `{success: true, <key>: …}` — the shape the client unwraps generically. */
function envelope(operationEnvelopeKey: string | null, isArray: boolean): Reply {
  return (_request, response) => {
    const payload = operationEnvelopeKey
      ? { success: true, [operationEnvelopeKey]: isArray ? [] : {} }
      : { success: true }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  }
}

class Stub {
  readonly seen: Seen[] = []
  private server: Server | undefined
  private reply: Reply = envelope('data', false)

  async start(): Promise<void> {
    this.server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const record: Seen = {
          method: request.method ?? '',
          pathname: url.pathname,
          search: url.search,
          headers: request.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks),
        }
        this.seen.push(record)
        this.reply(record, response)
      })
    })
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done))
  }

  get baseUrl(): string {
    const address = this.server?.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  /** Installs the response for the next run and forgets anything seen so far. */
  answers(reply: Reply): void {
    this.reply = reply
    this.seen.length = 0
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      if (!this.server) return done()
      this.server.close(() => done())
    })
  }
}

const stub = new Stub()

interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
}

function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  // stdout is collected as bytes: one operation answers a file, and decoding it as UTF-8 would
  // corrupt exactly the case this suite exists to cover.
  const inherited = { ...process.env }
  for (const name of ['NO_COLOR', 'FORCE_COLOR']) delete inherited[name]

  const child = spawn(process.execPath, [CLI, '--base-url', stub.baseUrl, ...args], {
    env: { ...inherited, WEEEK_TOKEN: TOKEN, WEEEK_CONFIG_DIR: configDir, ...env },
  })

  return new Promise<RunResult>((done, fail) => {
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', fail)
    child.on('close', (code) => done({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }))
  })
}

const configDir = built ? mkdtempSync(join(tmpdir(), 'weeek-wire-')) : ''

beforeAll(async () => {
  if (built) await stub.start()
})
afterAll(async () => {
  if (built) await stub.stop()
})

// ------------------------------------------------------------------------------------------
// The whole surface, actually sent
// ------------------------------------------------------------------------------------------

/** A value for a flag, and what the request body should then contain. */
function valueFor(field: { type: string; enum?: readonly (string | number)[] }): {
  argv: string
  expected: unknown
} {
  if (field.enum && field.enum.length > 0) {
    const member = field.enum[0] as string | number
    return { argv: String(member), expected: member }
  }
  if (field.type === 'integer' || field.type === 'number') return { argv: '7', expected: 7 }
  if (field.type === 'boolean') return { argv: 'true', expected: true }
  if (field.type === 'array') return { argv: '[]', expected: [] }
  if (field.type === 'object') return { argv: '{}', expected: {} }
  return { argv: 'sent-by-the-test', expected: 'sent-by-the-test' }
}

describe.skipIf(!built)('every operation reaches the API with the values it was given', () => {
  const cases = OPERATIONS.map((operation) => [operation.command.join(' '), operation] as const)

  it.each(cases)('%s', async (_name, operation) => {
    const args = [...operation.command]
    for (const param of operation.params) if (param.in === 'path') args.push('42')

    // Every flag, not only the required ones: the question is whether a value typed on the
    // command line arrives intact, and an optional flag that silently drops its value fails
    // exactly the same way a required one does. This is the wire counterpart of
    // tests/contract/flags.test.ts, which stops at local validation.
    const expectedQuery = new Map<string, string>()
    for (const param of operation.params) {
      if (param.in !== 'query') continue
      if (param.type === 'boolean') {
        args.push(`--${param.cli}`)
        expectedQuery.set(param.name, '1')
        continue
      }
      const { argv } = valueFor(param)
      args.push(`--${param.cli}`, argv)
      // Arrays go out as `name[]=value`; the client encodes that, the server sees it.
      expectedQuery.set(param.type === 'array' ? `${param.name}[]` : param.name, argv)
    }

    const expectedBody = new Map<string, unknown>()
    for (const field of operation.body?.fields ?? []) {
      const { argv, expected } = valueFor(field)
      args.push(`--${field.cli}`, argv)
      expectedBody.set(field.name, expected)
    }
    if (operation.body?.contentType === 'multipart') args.push('--file', fixtureFile)
    // Deletes refuse to run unattended without this, which is itself asserted further down.
    if (operation.method === 'DELETE') args.push('--yes')

    stub.answers(
      operation.binary
        ? (_request, response) => {
            response.writeHead(200, { 'content-type': 'application/octet-stream' })
            response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
          }
        : envelope(operation.envelopeKey, operation.responseIsArray),
    )

    const { code, stderr } = await run([...args, '--json'])
    expect(code, stderr).toBe(0)

    const [seen] = stub.seen
    expect(stub.seen).toHaveLength(1)
    expect(seen?.method).toBe(operation.method)
    expect(seen?.pathname.replace('/public/v1', '')).toBe(
      operation.path.replace(/\{[^}]+\}/g, '42'),
    )

    // The point of doing this end-to-end: the value typed on the command line has to arrive.
    const search = new URLSearchParams(seen?.search ?? '')
    for (const [name, value] of expectedQuery) expect(search.get(name), name).toBe(value)

    if (expectedBody.size > 0 && operation.body?.contentType === 'json') {
      const body = JSON.parse(seen?.body.toString('utf8') || '{}') as Record<string, unknown>
      for (const [name, value] of expectedBody) expect(body[name], name).toEqual(value)
    }
  })
})

// ------------------------------------------------------------------------------------------
// The cases a registry-driven sweep cannot express
// ------------------------------------------------------------------------------------------

const fixtureDir = built ? mkdtempSync(join(tmpdir(), 'weeek-files-')) : ''
const fixtureFile = built ? join(fixtureDir, 'report.txt') : ''
const FIXTURE_BYTES = Buffer.from('attachment contents, verbatim\n')

beforeAll(() => {
  if (built) require('node:fs').writeFileSync(fixtureFile, FIXTURE_BYTES)
})

describe.skipIf(!built)('multipart uploads', () => {
  it('sends the file as a part, with a boundary the client did not hand-write', async () => {
    stub.answers(envelope('data', false))

    const { code, stderr } = await run([
      'task',
      'attachment',
      'upload',
      '8123',
      '--file',
      fixtureFile,
      '--json',
    ])
    expect(code, stderr).toBe(0)

    const [seen] = stub.seen
    // `fetch` must be left to set this header: a hand-written content-type would carry no
    // boundary, and the server would see one unparseable blob.
    expect(seen?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)

    const body = seen?.body.toString('utf8') ?? ''
    expect(body).toContain('filename="report.txt"')
    expect(body).toContain(FIXTURE_BYTES.toString('utf8').trim())
  })
})

describe.skipIf(!built)('binary downloads', () => {
  // A PNG header: not valid UTF-8, so any accidental decoding shows up as corruption.
  const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])

  function answersBytes(): void {
    stub.answers((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(BYTES)
    })
  }

  it('streams the bytes to stdout untouched', async () => {
    answersBytes()
    const { code, stdout, stderr } = await run(['attachment', 'download', 'f1e2d3'])

    expect(code, stderr).toBe(0)
    expect(stdout.equals(BYTES), stdout.toString('hex')).toBe(true)
  })

  it('writes the same bytes to --output-file, and nothing to stdout', async () => {
    answersBytes()
    const target = join(fixtureDir, 'downloaded.png')
    const { code, stdout, stderr } = await run([
      'attachment',
      'download',
      'f1e2d3',
      '--output-file',
      target,
    ])

    expect(code, stderr).toBe(0)
    expect(readFileSync(target).equals(BYTES)).toBe(true)
    expect(stdout).toHaveLength(0)
  })
})

describe.skipIf(!built)('pagination', () => {
  it('--all-pages follows the second page and returns one merged array', async () => {
    let page = 0
    stub.answers((_request, response) => {
      page += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          page === 1
            ? { success: true, tasks: [{ id: 1 }, { id: 2 }], hasMore: true }
            : { success: true, tasks: [{ id: 3 }], hasMore: false },
        ),
      )
    })

    const { code, stdout, stderr } = await run([
      'task',
      'list',
      '--project-id',
      '4',
      '--all-pages',
      '--json',
    ])

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout.toString('utf8'))).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(stub.seen).toHaveLength(2)

    // The window must advance by exactly what the first page returned. Asserting only that it
    // changed would pass on an offset that jumped, skipping records, or on one that came back
    // as undefined — and "follow every page" is an infinite loop if it does not move at all.
    const first = new URLSearchParams(stub.seen[0]?.search ?? '')
    const second = new URLSearchParams(stub.seen[1]?.search ?? '')
    expect(first.get('offset')).toBe('0')
    expect(second.get('offset')).toBe('2')
    expect(second.get('perPage')).toBe(first.get('perPage'))
  })

  it('without --all-pages it asks once', async () => {
    stub.answers((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: true, tasks: [{ id: 1 }], hasMore: true }))
    })

    await run(['task', 'list', '--project-id', '4', '--json'])
    expect(stub.seen).toHaveLength(1)
  })
})

describe.skipIf(!built)('query encoding, as the server sees it', () => {
  it('repeats array parameters with [] and sends booleans as 1', async () => {
    stub.answers(envelope('tasks', true))

    await run([
      'task',
      'list',
      '--project-id',
      '4',
      '--tags',
      '1',
      '2',
      '--completed',
      '--sort-by',
      '-created',
      '--json',
    ])

    const search = stub.seen[0]?.search ?? ''
    expect(search).toContain('tags%5B%5D=1&tags%5B%5D=2')
    expect(search).toContain('completed=1')
    // The documented descending form; it used to be rejected locally before it could be sent.
    expect(search).toContain('sortBy=-created')
  })
})

describe.skipIf(!built)('HTTP status becomes an exit code', () => {
  const cases: [string, number, unknown, number][] = [
    ['401', 401, { success: false, message: 'Unauthenticated.' }, 3],
    ['403', 403, { success: false, message: 'Forbidden' }, 3],
    ['404', 404, { success: false, message: 'Record not found' }, 4],
    // The live API's own way of saying "not found": 400 with a code in the body.
    ['400 with the not-found code', 400, { code: 1000001, message: 'Model not found' }, 4],
    ['422', 422, { success: false, errors: { title: ['required'] } }, 2],
    ['500', 500, { success: false, message: 'Server error' }, 5],
  ]

  it.each(cases)('%s exits %s', async (_name, status, payload, expected) => {
    stub.answers((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })

    const { code, stdout } = await run(['tag', 'get', '5', '--json'])
    expect(code).toBe(expected)
    // Errors are commentary: stdout stays clean so a pipeline sees no half-formed data.
    expect(stdout.toString('utf8')).toBe('')
  })

  it('reports the field a 422 names, not the generic message', async () => {
    stub.answers((_request, response) => {
      response.writeHead(422, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          success: false,
          message: 'The given data was invalid.',
          errors: { title: ['The title field is required.'] },
        }),
      )
    })

    const { stderr } = await run(['tag', 'get', '5', '--json'])
    expect(stderr).toContain('title')
  })
})

describe.skipIf(!built)('rate limiting', () => {
  it('retries after a 429 and succeeds without the caller noticing', async () => {
    let attempt = 0
    stub.answers((_request, response) => {
      attempt += 1
      if (attempt === 1) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
        response.end(JSON.stringify({ success: false, message: 'Too many requests' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: true, tag: { id: 5 } }))
    })

    const { code, stdout, stderr } = await run(['tag', 'get', '5', '--json'])

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout.toString('utf8'))).toEqual({ id: 5 })
    expect(stub.seen).toHaveLength(2)
  })
})

describe.skipIf(!built)('envelopes', () => {
  // The payload key comes from the registry, not from inspecting the response: it is derived
  // once, at codegen time, from the documented response schema. These cases pin what that
  // means at the process boundary.
  const cases: [string, unknown, unknown][] = [
    ['the declared key', { success: true, tag: { id: 5 } }, { id: 5 }],
    // One operation in the source document misspells the flag as `sucess`. Because only the
    // payload key is looked up, the misspelling costs nothing — which this proves rather than
    // assumes.
    ['a misspelled success flag', { sucess: true, tag: { id: 9 } }, { id: 9 }],
    ['a response missing its declared key', { success: true }, null],
    ['an undeclared key, ignored', { success: true, data: [{ id: 1 }] }, null],
  ]

  it.each(cases)('%s', async (_name, payload, expected) => {
    stub.answers((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })

    const { code, stdout } = await run(['tag', 'get', '5', '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout.toString('utf8'))).toEqual(expected)
  })

  it('keeps data an operation was not documented to return', async () => {
    // `task start-timer` documents `{success: true}` and nothing else, so there is no declared
    // key to read. Discarding whatever the API actually sent would be the worse failure: the
    // source document under-describes responses throughout.
    stub.answers((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: true, timer: { startedAt: '2026-07-25' } }))
    })

    const { code, stdout } = await run(['task', 'start-timer', '8123', '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout.toString('utf8'))).toEqual({ startedAt: '2026-07-25' })
  })
})

describe.skipIf(!built)('a refused confirmation sends nothing', () => {
  it('exits 2 without opening a connection', async () => {
    stub.answers(envelope(null, false))

    const { code, stderr } = await run(['tag', 'delete', '5', '--json'])

    expect(code).toBe(2)
    expect(stderr).toContain('--yes')
    // The assertion that matters: refusing to confirm is not "ask, then send anyway".
    expect(stub.seen).toHaveLength(0)
  })

  it('sends it with --yes', async () => {
    stub.answers(envelope(null, false))

    const { code } = await run(['tag', 'delete', '5', '--yes', '--json'])

    expect(code).toBe(0)
    expect(stub.seen).toHaveLength(1)
    expect(stub.seen[0]?.method).toBe('DELETE')
  })

  it('--dry-run sends nothing either, on any command', async () => {
    stub.answers(envelope('tasks', true))

    const { code } = await run(['task', 'list', '--project-id', '4', '--dry-run', '--json'])

    expect(code).toBe(0)
    expect(stub.seen).toHaveLength(0)
  })
})

describe.skipIf(!built)('--verbose', () => {
  it('traces the query string and never the token', async () => {
    stub.answers(envelope('tasks', true))

    const { stderr } = await run([
      '--verbose',
      'task',
      'list',
      '--project-id',
      '4',
      '--completed',
      '--json',
    ])

    expect(stderr).toContain('GET /tm/tasks')
    expect(stderr).toContain('completed=1')
    expect(stderr).not.toContain(TOKEN)
  })

  it('sends the token as a bearer credential', async () => {
    stub.answers(envelope('tasks', true))

    await run(['task', 'list', '--project-id', '4', '--json'])
    expect(stub.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })
})

describe.skipIf(!built)('the sweep above cannot go quiet', () => {
  // A sweep that stops passing values would still be green while proving nothing. These are
  // the properties that make it meaningful, asserted rather than assumed.
  it('carries values for a substantial share of the surface', () => {
    const withQuery = OPERATIONS.filter((operation) =>
      operation.params.some((param) => param.in === 'query'),
    )
    const withBody = OPERATIONS.filter((operation) => (operation.body?.fields.length ?? 0) > 0)

    expect(withQuery.length).toBeGreaterThan(5)
    expect(withBody.length).toBeGreaterThan(50)
    expect(OPERATIONS.filter((operation) => operation.method === 'DELETE').length).toBeGreaterThan(
      10,
    )
    expect(
      OPERATIONS.filter((operation) => operation.body?.contentType === 'multipart').length,
    ).toBeGreaterThan(0)
    expect(OPERATIONS.filter((operation) => operation.binary).length).toBe(1)
  })
})

describe.skipIf(!built)('--body, --no-validate and the order they apply in', () => {
  it('merges --body over the generated flags', async () => {
    stub.answers(envelope('tag', false))

    const { code, stderr } = await run([
      'tag',
      'update',
      '5',
      '--title',
      'from the flag',
      '--body-color',
      'blue',
      '--body',
      '{"title":"from --body","extra":true}',
      '--json',
    ])

    expect(code, stderr).toBe(0)
    const body = JSON.parse(stub.seen[0]?.body.toString('utf8') ?? '{}')
    // Documented as "merged over": --body wins on collision and can add what no flag expresses.
    expect(body).toEqual({ title: 'from --body', color: 'blue', extra: true })
  })

  it('rejects a bad body before opening a connection', async () => {
    stub.answers(envelope('tag', false))

    const { code, stderr } = await run([
      'task',
      'assignee',
      'add',
      '8123',
      '--assignees',
      '[123]',
      '--json',
    ])

    expect(code).toBe(2)
    expect(stderr).toContain('assignees')
    // Local validation exists to save a round trip; if it still sent one, it would be theatre.
    expect(stub.seen).toHaveLength(0)
  })

  it('--no-validate sends what the spec would have refused', async () => {
    stub.answers(envelope(null, false))

    const { code, stderr } = await run([
      'task',
      'assignee',
      'add',
      '8123',
      '--assignees',
      '[123]',
      '--no-validate',
      '--json',
    ])

    expect(code, stderr).toBe(0)
    expect(stub.seen).toHaveLength(1)
    expect(JSON.parse(stub.seen[0]?.body.toString('utf8') ?? '{}')).toEqual({ assignees: [123] })
  })
})

describe.skipIf(!built)('responses that are not JSON objects', () => {
  it('accepts 204 No Content as success with no payload', async () => {
    stub.answers((_request, response) => {
      response.writeHead(204)
      response.end()
    })

    const { code, stdout, stderr } = await run([
      'task',
      'location',
      'add',
      '8123',
      '--project-id',
      '4',
      '--json',
    ])

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout.toString('utf8'))).toBeNull()
  })

  it('reports an unreachable server as a network error, not a crash', async () => {
    // Port 1 on loopback: nothing listens, and the connection is refused immediately.
    const child = spawn(
      process.execPath,
      [CLI, '--base-url', 'http://127.0.0.1:1', 'tag', 'list', '--json'],
      { env: { ...process.env, WEEEK_TOKEN: TOKEN, WEEEK_CONFIG_DIR: configDir } },
    )

    const result = await new Promise<{ code: number; stderr: string }>((done) => {
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('close', (code) => done({ code: code ?? -1, stderr }))
    })

    expect(result.code).toBe(6)
    expect(result.stderr).not.toContain('at ')
  })
})
