/**
 * HTTP client for the WEEEK public API.
 *
 * Handles the parts the spec leaves undefined: envelope unwrapping (which differs per
 * operation and includes a misspelled flag), query encoding for arrays and booleans, retries,
 * binary downloads and multipart uploads.
 */

import {
  BOOLEAN_WIRE_FORMAT,
  ENVELOPE_META_KEYS,
  QUERY_ARRAY_FORMAT,
} from '../../../spec/overrides.ts'
import { redact, registerSecret } from '../auth/redact.ts'
import { errorFromResponse, parseRetryAfter, WeeekError } from './errors.ts'
import type { OperationMeta } from './generated/operations.ts'

export const DEFAULT_BASE_URL = 'https://api.weeek.net/public/v1'

export interface ClientOptions {
  token: string
  baseUrl?: string
  /** Receives one line per request; the CLI wires this to stderr under --verbose. */
  onTrace?: (line: string) => void
  /** Total attempts for retryable failures, including the first. */
  maxAttempts?: number
  /** Milliseconds before a single request is aborted. */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  /** Injectable for tests; real sleeps make retry tests slow. */
  sleep?: (ms: number) => Promise<void>
}

export interface RequestOptions {
  path: Record<string, string | number>
  query: Record<string, unknown>
  body?: unknown
  /** Multipart parts for the two upload endpoints. */
  files?: { field: string; file: Blob; filename: string }[]
  signal?: AbortSignal
}

export interface PageInfo {
  hasMore: boolean
}

const RETRY_BASE_MS = 500
const MAX_BACKOFF_MS = 20_000

/**
 * Encodes one query value.
 *
 * Two undocumented details, both recorded in spec/overrides.ts:
 *   - booleans go on the wire as 0/1; `true`/`false` is accepted but does not filter,
 *   - arrays have no declared `style`/`explode`, so the bracket form is used.
 */
function appendQueryValue(
  params: URLSearchParams,
  name: string,
  value: unknown,
  wire: OperationMeta['params'][number]['wire'],
): void {
  if (value === undefined || value === null) return

  if (Array.isArray(value)) {
    if (value.length === 0) return
    switch (QUERY_ARRAY_FORMAT.style) {
      case 'brackets':
        for (const item of value) params.append(`${name}[]`, String(item))
        return
      case 'repeat':
        for (const item of value) params.append(name, String(item))
        return
      case 'comma':
        params.append(name, value.join(','))
        return
    }
  }

  if (typeof value === 'boolean') {
    const numeric = wire === 'numeric-bool' || BOOLEAN_WIRE_FORMAT.style === 'numeric'
    params.append(name, numeric ? (value ? '1' : '0') : String(value))
    return
  }

  params.append(name, String(value))
}

export function buildQuery(operation: OperationMeta, query: Record<string, unknown>): string {
  const params = new URLSearchParams()

  for (const [name, value] of Object.entries(query)) {
    const meta = operation.params.find((p) => p.in === 'query' && p.name === name)
    appendQueryValue(params, name, value, meta?.wire)
  }

  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

export function buildPath(
  operation: OperationMeta,
  values: Record<string, string | number>,
): string {
  return operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined || value === '') {
      throw new WeeekError({
        kind: 'input',
        message: `Missing path parameter "${name}" for ${operation.id}`,
      })
    }
    return encodeURIComponent(String(value))
  })
}

/**
 * Extracts the payload from a response envelope.
 *
 * Envelopes are per-operation (`{success, tasks}`, `{success, deals, hasMoreDeals}`,
 * `{success, data, hasMore}`) and one operation misspells the flag as `sucess`, so the payload
 * key comes from the registry rather than from guessing at runtime.
 *
 * A null `envelopeKey` is meaningful, not unknown: 77 operations document their response as
 * exactly `{success: true}`. Those yield `null`. If such a response nonetheless carries
 * unexpected keys, they are returned rather than discarded — the spec under-describes responses
 * often enough that silently dropping data would be the worse failure.
 */
export function unwrapEnvelope(operation: OperationMeta, body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body

  const record = body as Record<string, unknown>

  if (operation.envelopeKey) {
    return operation.envelopeKey in record ? record[operation.envelopeKey] : null
  }

  const extra = Object.keys(record).filter((key) => !ENVELOPE_META_KEYS.has(key))
  if (extra.length === 0) return null
  if (extra.length === 1) return record[extra[0] as string]
  return Object.fromEntries(extra.map((key) => [key, record[key]]))
}

export function readPageInfo(operation: OperationMeta, body: unknown): PageInfo {
  if (!operation.hasMoreKey || !body || typeof body !== 'object') return { hasMore: false }
  return { hasMore: (body as Record<string, unknown>)[operation.hasMoreKey] === true }
}

export class WeeekClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly doFetch: typeof globalThis.fetch
  private readonly onTrace: ((line: string) => void) | undefined
  private readonly maxAttempts: number
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: ClientOptions) {
    this.token = options.token
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.onTrace = options.onTrace
    this.maxAttempts = options.maxAttempts ?? 3
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

    // Makes the token maskable everywhere, including in errors thrown by other layers.
    registerSecret(this.token)
  }

  /** Performs the request and returns the unwrapped payload. */
  async call<T = unknown>(operation: OperationMeta, options: RequestOptions): Promise<T> {
    const { body } = await this.callRaw(operation, options)
    return unwrapEnvelope(operation, body) as T
  }

  /** Performs the request and returns the full envelope, for callers that need `hasMore`. */
  async callRaw(
    operation: OperationMeta,
    options: RequestOptions,
  ): Promise<{ body: unknown; page: PageInfo }> {
    const response = await this.send(operation, options)

    if (operation.successStatus === 204 || response.status === 204) {
      return { body: null, page: { hasMore: false } }
    }

    const text = await response.text()
    const parsed = text === '' ? null : this.parseJson(text, operation, response)
    return { body: parsed, page: readPageInfo(operation, parsed) }
  }

  /**
   * Downloads a binary response. Separate from `call` on purpose: attachments return file
   * bytes, and running them through envelope unwrapping or a JSON formatter corrupts them.
   */
  async download(
    operation: OperationMeta,
    options: RequestOptions,
  ): Promise<{
    stream: ReadableStream<Uint8Array> | null
    contentType: string
    filename?: string
  }> {
    if (!operation.binary) {
      throw new WeeekError({
        kind: 'input',
        message: `${operation.id} does not return a binary response`,
      })
    }

    const response = await this.send(operation, options)
    const disposition = response.headers.get('content-disposition') ?? ''
    const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1]

    return {
      stream: response.body,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      ...(filename ? { filename: decodeURIComponent(filename) } : {}),
    }
  }

  /** Follows `hasMore` for the operations that actually declare pagination. */
  async *paginate<T = unknown>(
    operation: OperationMeta,
    options: RequestOptions,
    pageSize = 100,
  ): AsyncGenerator<T[]> {
    if (!operation.paginated) {
      const single = await this.call<T[]>(operation, options)
      yield Array.isArray(single) ? single : ([single] as T[])
      return
    }

    let offset = Number(options.query.offset ?? 0)
    for (;;) {
      const query = { ...options.query, perPage: pageSize, offset }
      const { body, page } = await this.callRaw(operation, { ...options, query })
      const items = unwrapEnvelope(operation, body)
      const batch = (Array.isArray(items) ? items : []) as T[]

      if (batch.length > 0) yield batch
      if (!page.hasMore || batch.length === 0) return
      offset += batch.length
    }
  }

  private parseJson(text: string, operation: OperationMeta, response: Response): unknown {
    try {
      return JSON.parse(text)
    } catch (cause) {
      throw new WeeekError({
        kind: 'api',
        message: `Expected JSON from ${operation.method} ${operation.path} but got ${
          response.headers.get('content-type') ?? 'an unreadable body'
        }`,
        status: response.status,
        request: { method: operation.method, path: operation.path },
        cause,
      })
    }
  }

  private async send(operation: OperationMeta, options: RequestOptions): Promise<Response> {
    const path = buildPath(operation, options.path)
    const url = `${this.baseUrl}${path}${buildQuery(operation, options.query)}`
    const requestInfo = { method: operation.method, path }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: operation.binary ? '*/*' : 'application/json',
    }

    let payload: FormData | string | undefined
    if (options.files && options.files.length > 0) {
      const form = new FormData()
      for (const [key, value] of Object.entries(options.body ?? {})) {
        if (value !== undefined && value !== null) form.append(key, String(value))
      }
      for (const part of options.files) form.append(part.field, part.file, part.filename)
      payload = form
      // Deliberately not setting content-type: fetch must add the multipart boundary itself.
    } else if (options.body !== undefined && options.body !== null) {
      payload = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }

    let lastError: WeeekError | undefined

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const started = Date.now()
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

      let response: Response
      try {
        response = await this.doFetch(url, {
          method: operation.method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          signal,
        })
      } catch (cause) {
        const aborted = options.signal?.aborted === true
        lastError = new WeeekError({
          kind: 'network',
          message: aborted
            ? 'Request cancelled'
            : `Could not reach ${this.baseUrl} (${(cause as Error).message})`,
          request: requestInfo,
          cause,
        })
        // A cancelled request is a decision, not a failure to retry.
        if (aborted) throw lastError
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffFor(attempt))
          continue
        }
        throw lastError
      }

      this.trace(operation, path, response.status, Date.now() - started, attempt)

      if (response.ok) return response

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      const errorBody = await this.readErrorBody(response)
      const error = errorFromResponse(
        response.status,
        response.statusText,
        errorBody,
        requestInfo,
        retryAfter,
      )

      if (error.retryable && attempt < this.maxAttempts) {
        lastError = error
        await this.sleep(retryAfter !== undefined ? retryAfter * 1000 : this.backoffFor(attempt))
        continue
      }

      throw error
    }

    /* c8 ignore next */
    throw lastError ?? new WeeekError({ kind: 'network', message: 'Request failed' })
  }

  private async readErrorBody(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '')
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /** Exponential backoff with jitter, so retries from many clients do not align. */
  private backoffFor(attempt: number): number {
    const exponential = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
    return exponential + Math.random() * RETRY_BASE_MS
  }

  private trace(
    operation: OperationMeta,
    path: string,
    status: number,
    ms: number,
    attempt: number,
  ): void {
    if (!this.onTrace) return
    const retry = attempt > 1 ? ` (attempt ${attempt})` : ''
    this.onTrace(redact(`${operation.method} ${path} → ${status} ${ms}ms${retry}`))
  }
}
