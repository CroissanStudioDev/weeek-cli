/**
 * Resolves the `assumed` entries in spec/overrides.ts against the real API.
 *
 * Three encoding decisions are inferences from a reconstructed spec, and each one silently
 * changes what the API returns rather than failing loudly:
 *
 *   1. arrays in a query string — `tags[]=1&tags[]=2` or `tags=1,2`
 *   2. booleans — `0`/`1` or `true`/`false`
 *   3. `/crm/statuses/{id}` — the spec says `/crm/statuses{id}`, with no slash
 *
 * Everything here is read-only: GETs and one deliberate 404 probe. It creates nothing, changes
 * nothing, and deletes nothing.
 *
 *   WEEEK_TOKEN=… bun run scripts/probe-live.ts
 *
 * Report the output in a PR or issue; each answer is a one-line change to overrides.ts plus a
 * test. The results are printed, never written back — a script that edits the override table
 * from a single workspace's behaviour would hide exactly the disagreement worth seeing.
 */

import { DEFAULT_BASE_URL } from '../src/core/api/client.ts'

const token = process.env.WEEEK_TOKEN
if (!token) {
  console.error(
    'Set WEEEK_TOKEN first (workspace settings → API).\n' +
      '  WEEEK_TOKEN=… bun run scripts/probe-live.ts',
  )
  process.exit(3)
}

const baseUrl = process.env.WEEEK_BASE_URL ?? DEFAULT_BASE_URL

interface Probe {
  question: string
  /** Candidate encodings, in the order they are tried. */
  attempts: { label: string; path: string }[]
  /** Reads whatever distinguishes a working request from an ignored parameter. */
  describe: (status: number, body: unknown) => string
}

async function call(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Left as text: an HTML error page is itself the answer.
  }
  return { status: response.status, body }
}

function count(body: unknown, key: string): number | null {
  if (typeof body !== 'object' || body === null) return null
  const value = (body as Record<string, unknown>)[key]
  return Array.isArray(value) ? value.length : null
}

/** The baseline the filtered counts are compared against. */
const baseline = await call('/tm/tasks')
const baselineTasks = count(baseline.body, 'tasks')

console.log(`base URL     ${baseUrl}`)
console.log(`GET /tm/tasks → ${baseline.status}, ${baselineTasks ?? '?'} tasks unfiltered\n`)

if (baseline.status !== 200) {
  console.error('The baseline request failed; fix credentials before reading anything below.')
  console.error(JSON.stringify(baseline.body, null, 2).slice(0, 600))
  process.exit(5)
}

const probes: Probe[] = [
  {
    question: 'DEFECT 8 — how are array query parameters serialised?',
    attempts: [
      { label: 'brackets  tags[]=1&tags[]=2', path: '/tm/tasks?tags[]=1&tags[]=2' },
      { label: 'comma     tags=1,2', path: '/tm/tasks?tags=1,2' },
      { label: 'repeated  tags=1&tags=2', path: '/tm/tasks?tags=1&tags=2' },
    ],
    describe: (status, body) => {
      const n = count(body, 'tasks')
      const changed = n !== null && baselineTasks !== null && n !== baselineTasks
      return `${status}, ${n ?? '?'} tasks${changed ? '  ← filtered' : '  (same as unfiltered)'}`
    },
  },
  {
    question: 'BOOLEAN_WIRE_FORMAT — 0/1 or true/false?',
    attempts: [
      { label: 'numeric   completed=1', path: '/tm/tasks?completed=1' },
      { label: 'literal   completed=true', path: '/tm/tasks?completed=true' },
      { label: 'numeric   completed=0', path: '/tm/tasks?completed=0' },
      { label: 'literal   completed=false', path: '/tm/tasks?completed=false' },
    ],
    describe: (status, body) => {
      const n = count(body, 'tasks')
      const changed = n !== null && baselineTasks !== null && n !== baselineTasks
      return `${status}, ${n ?? '?'} tasks${changed ? '  ← filtered' : '  (same as unfiltered)'}`
    },
  },
  {
    question: 'DEFECT 1 — does /crm/statuses/{id} need the slash the spec omits?',
    attempts: [
      { label: 'with slash    /crm/statuses/1', path: '/crm/statuses/1' },
      { label: 'as specified  /crm/statuses1', path: '/crm/statuses1' },
    ],
    // A 404 for a status that does not exist still proves the route is real; 404 for both would
    // mean the id is simply wrong, so the status codes must be read together.
    describe: (status, body) =>
      `${status}${typeof body === 'object' && body !== null ? `  ${JSON.stringify(body).slice(0, 120)}` : ''}`,
  },
  {
    question: 'DEFECT 4 — what do error bodies actually look like?',
    attempts: [
      { label: '404  /tm/tasks/999999999', path: '/tm/tasks/999999999' },
      { label: '422  /tm/tasks?perPage=notanumber', path: '/tm/tasks?perPage=notanumber' },
      { label: '404  /tm/does-not-exist', path: '/tm/does-not-exist' },
    ],
    describe: (status, body) => `${status}  ${JSON.stringify(body).slice(0, 200)}`,
  },
]

for (const probe of probes) {
  console.log(probe.question)
  for (const attempt of probe.attempts) {
    const { status, body } = await call(attempt.path)
    console.log(`  ${attempt.label.padEnd(30)} ${probe.describe(status, body)}`)
  }
  console.log()
}

// One unauthenticated request, to see the shape the client maps to exit code 3.
const anonymous = await fetch(`${baseUrl}/user/me`, { headers: { Accept: 'application/json' } })
console.log('401 shape (no Authorization header)')
console.log(`  ${anonymous.status}  ${(await anonymous.text()).slice(0, 200)}`)
