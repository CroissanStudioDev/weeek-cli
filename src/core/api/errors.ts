/**
 * Error taxonomy for the WEEEK API.
 *
 * The spec documents only success responses and defines no error schema at all
 * (overrides: DEFECT 4), so everything here is hand-written and the error body is discovered
 * at runtime rather than parsed against a contract.
 *
 * Errors carry a `kind` instead of an exit code: mapping to process exit codes belongs to the
 * CLI layer (`cli/exit-codes.ts`), and core must stay usable as a library.
 */

export type ErrorKind =
  | 'auth' // 401 / 403 — missing, invalid or insufficient token
  | 'not-found' // 404
  | 'validation' // 400 / 422 — the request was understood and rejected
  | 'rate-limit' // 429
  | 'api' // any other non-2xx
  | 'network' // transport failed, request never got an answer
  | 'input' // rejected locally, before any request went out

export interface WeeekErrorInit {
  kind: ErrorKind
  message: string
  status?: number
  /** Method and path of the failing request, never the full URL with a token in it. */
  request?: { method: string; path: string }
  /** Parsed response body, when there was one and it was JSON. */
  body?: unknown
  /** Seconds to wait, from Retry-After, when the server supplied it. */
  retryAfter?: number
  cause?: unknown
}

export class WeeekError extends Error {
  readonly kind: ErrorKind
  readonly status: number | undefined
  readonly request: { method: string; path: string } | undefined
  readonly body: unknown
  readonly retryAfter: number | undefined

  constructor(init: WeeekErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'WeeekError'
    this.kind = init.kind
    this.status = init.status
    this.request = init.request
    this.body = init.body
    this.retryAfter = init.retryAfter
  }

  /** True when retrying the identical request could plausibly succeed. */
  get retryable(): boolean {
    if (this.kind === 'network' || this.kind === 'rate-limit') return true
    return this.status !== undefined && this.status >= 500
  }
}

/**
 * Error codes the API sends in the body, which do not line up with its HTTP status.
 *
 * Verified against the live API: asking for a task that does not exist answers
 * `400 {"success":false,"code":1000001,"message":"Model not found"}`. Read from the status
 * alone that is a validation error, and `weeek task get 999999999` would exit 2 ("bad input")
 * instead of the documented 4 ("not found") — wrong for anyone branching on the exit code.
 */
const BODY_CODES: Record<number, ErrorKind> = {
  1000001: 'not-found', // "Model not found", sent with HTTP 400
  2000000: 'auth', // "Unauthenticated.", sent with HTTP 401
}

/** The numeric `code` from an error envelope, when there is one. */
function bodyCode(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined
  const code = (body as Record<string, unknown>).code
  return typeof code === 'number' ? code : undefined
}

function kindForStatus(status: number, body?: unknown): ErrorKind {
  const declared = BODY_CODES[bodyCode(body) ?? -1]
  if (declared) return declared

  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not-found'
  if (status === 400 || status === 422) return 'validation'
  if (status === 429) return 'rate-limit'
  return 'api'
}

/**
 * Pulls a human message out of an undocumented error body.
 *
 * Observed envelopes use `{success: false, message}`, but since nothing is specified we probe a
 * few shapes and fall back to the status line rather than inventing detail we do not have.
 */
export function messageFromBody(body: unknown, status: number, statusText: string): string {
  if (typeof body === 'string' && body.trim() !== '') return body.trim()

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>

    // Field errors first, deliberately. The live API sends both, and the generic one is
    // useless on its own: {"message":"The field is required.","errors":{"projectId":[…]}} —
    // only the `errors` map says *which* field.
    const errors = record.errors
    if (errors && typeof errors === 'object') {
      const parts: string[] = []
      for (const [field, messages] of Object.entries(errors as Record<string, unknown>)) {
        const text = Array.isArray(messages) ? messages.join(', ') : String(messages)
        parts.push(`${field}: ${text}`)
      }
      if (parts.length > 0) return parts.join('; ')
    }

    for (const key of ['message', 'error', 'detail', 'description']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }

  return statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`
}

export function errorFromResponse(
  status: number,
  statusText: string,
  body: unknown,
  request: { method: string; path: string },
  retryAfter?: number,
): WeeekError {
  const kind = kindForStatus(status, body)
  const base = messageFromBody(body, status, statusText)

  // The API issues long-lived personal tokens with no scopes, so a 401 almost always means the
  // token is missing, revoked or mistyped — worth saying, since there is no refresh to attempt.
  const message =
    kind === 'auth'
      ? `${base} — check your token with \`weeek auth status\`, or sign in again with \`weeek auth login\``
      : base

  return new WeeekError({
    kind,
    message,
    status,
    request,
    body,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  })
}

/** Parses Retry-After, which may be seconds or an HTTP date. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined

  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds

  const date = Date.parse(header)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, (date - now) / 1000)
}
