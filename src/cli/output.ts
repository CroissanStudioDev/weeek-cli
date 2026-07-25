/**
 * Output contract.
 *
 * The rules (clig.dev / clispec.dev), each of which something downstream depends on:
 *   - stdout carries data only; progress, warnings and traces go to stderr, so
 *     `weeek task list --json | jq` never sees a spinner,
 *   - JSON output is a versioned interface, not a side effect of formatting,
 *   - no ANSI when stdout is not a TTY, or when NO_COLOR is set,
 *   - never prompt without a TTY — fail with a readable message instead of hanging.
 */

import { stringify as toYaml } from 'yaml'
import { redactValue } from '../core/auth/redact.ts'

export type OutputFormat = 'json' | 'table' | 'yaml'

export interface OutputOptions {
  format: OutputFormat
  color: boolean
  quiet: boolean
}

export interface Streams {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  isTTY: boolean
}

export function isBrokenPipe(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EPIPE'
}

export function defaultStreams(): Streams {
  return { stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY === true }
}

/**
 * Colour is on only when the user is actually looking at a terminal.
 * Honours NO_COLOR (no-color.org) and the explicit --no-color flag.
 */
export function shouldUseColor(
  streams: Streams,
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flag === false) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  // An empty FORCE_COLOR is how a parent process unsets it; treating it as a request for
  // colour puts ANSI into pipes. `0` is the documented way to force colour off.
  if (env.FORCE_COLOR === '0') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return true
  if (flag === true) return true
  return streams.isTTY
}

/** Default format: humans get a table, pipes get JSON. */
export function defaultFormat(streams: Streams): OutputFormat {
  return streams.isTTY ? 'table' : 'json'
}

// SGR escapes, built from the character code so the source contains no invisible control
// bytes (linters flag them and editors render them as nothing).
const ESC = String.fromCharCode(27)
const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
} as const

/** Strips SGR sequences so table alignment measures printed width, not string length. */
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

export function paint(text: string, style: keyof typeof ANSI, color: boolean): string {
  return color ? `${ANSI[style]}${text}${ANSI.reset}` : text
}

/** Columns shown by default; wide payloads are unreadable as a table otherwise. */
const PREFERRED_COLUMNS = [
  'id',
  'title',
  'name',
  'email',
  'status',
  'isCompleted',
  'priority',
  'projectId',
  'boardColumnId',
  'date',
]

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') return Array.isArray(value) ? `[${value.length}]` : '{…}'
  return String(value)
}

function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, '').length
}

export function renderTable(rows: Record<string, unknown>[], color: boolean): string {
  if (rows.length === 0) return ''

  const present = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) present.add(key)

  const preferred = PREFERRED_COLUMNS.filter((key) => present.has(key))
  const columns = preferred.length > 0 ? preferred : [...present].slice(0, 6)

  const header = columns.map((key) => paint(key, 'bold', color))
  const body = rows.map((row) => columns.map((key) => cell(row[key])))

  const widths = columns.map((_, index) =>
    Math.max(
      visibleWidth(header[index] as string),
      ...body.map((r) => visibleWidth(r[index] ?? '')),
    ),
  )

  const line = (cells: string[]) =>
    cells
      .map(
        (text, index) => text + ' '.repeat(Math.max(0, (widths[index] ?? 0) - visibleWidth(text))),
      )
      .join('  ')
      .trimEnd()

  return [line(header), ...body.map(line)].join('\n')
}

function asRows(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) {
    return value.every((item) => item && typeof item === 'object' && !Array.isArray(item))
      ? (value as Record<string, unknown>[])
      : null
  }
  if (value && typeof value === 'object') return [value as Record<string, unknown>]
  return null
}

export class Output {
  constructor(
    private readonly streams: Streams,
    private readonly options: OutputOptions,
  ) {}

  get format(): OutputFormat {
    return this.options.format
  }

  /** Writes the payload to stdout in the requested format. Data only — never commentary. */
  data(value: unknown): void {
    if (value === null || value === undefined) {
      // A successful mutation with no payload prints nothing in JSON mode, so that
      // `weeek task complete 1 --json` stays parseable (empty output, exit 0).
      if (this.options.format === 'json') this.write(this.streams.stdout, 'null\n')
      return
    }

    const safe = redactValue(value)

    switch (this.options.format) {
      case 'json':
        this.write(this.streams.stdout, `${JSON.stringify(safe, null, 2)}\n`)
        return
      case 'yaml':
        this.write(this.streams.stdout, toYaml(safe))
        return
      case 'table': {
        const rows = asRows(safe)
        if (!rows) {
          this.write(this.streams.stdout, `${String(safe)}\n`)
          return
        }
        if (rows.length === 0) {
          this.note('No results.')
          return
        }
        this.write(this.streams.stdout, `${renderTable(rows, this.options.color)}\n`)
        return
      }
    }
  }

  /** Human commentary. Always stderr, so it cannot corrupt piped data. */
  note(message: string): void {
    if (this.options.quiet) return
    this.write(this.streams.stderr, `${message}\n`)
  }

  warn(message: string): void {
    this.write(
      this.streams.stderr,
      `${paint('warning:', 'yellow', this.options.color)} ${message}\n`,
    )
  }

  error(message: string): void {
    this.write(this.streams.stderr, `${paint('error:', 'red', this.options.color)} ${message}\n`)
  }

  success(message: string): void {
    if (this.options.quiet) return
    this.write(this.streams.stderr, `${paint('✓', 'green', this.options.color)} ${message}\n`)
  }

  /** Request traces under --verbose. stderr, and already redacted by the client. */
  trace(line: string): void {
    this.write(this.streams.stderr, `${paint(line, 'dim', this.options.color)}\n`)
  }

  private write(stream: NodeJS.WritableStream, text: string): void {
    try {
      stream.write(text)
    } catch (error) {
      // `weeek schema --json | head -1` — or any consumer that exits before we finish writing —
      // closes the pipe under us. Printing a stack trace about it is exactly wrong: the shell
      // pipeline behaved normally, and the CLI's own promise is that stdout is safe to pipe.
      if (!isBrokenPipe(error)) throw error
    }
  }
}
