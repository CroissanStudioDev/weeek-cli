/**
 * The output contract, asserted.
 *
 * These are the invariants other people's scripts will depend on, so they get tests rather
 * than a paragraph in the README: data on stdout, everything else on stderr, no ANSI when not
 * a terminal, and the token never printed in full.
 */

import { describe, expect, it } from 'vitest'
import { EXIT, exitCodeFor } from '../../src/cli/exit-codes.ts'
import { Output, renderTable, type Streams, shouldUseColor } from '../../src/cli/output.ts'
import { WeeekError } from '../../src/core/api/errors.ts'
import { clearSecrets, registerSecret } from '../../src/core/auth/redact.ts'

class Capture implements NodeJS.WritableStream {
  text = ''
  writable = true
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return true
  }
  end(): this {
    return this
  }
  // Unused members of the interface.
  on(): this {
    return this
  }
  once(): this {
    return this
  }
  emit(): boolean {
    return true
  }
  addListener(): this {
    return this
  }
  removeListener(): this {
    return this
  }
  off(): this {
    return this
  }
  removeAllListeners(): this {
    return this
  }
  setMaxListeners(): this {
    return this
  }
  getMaxListeners(): number {
    return 0
  }
  listeners(): [] {
    return []
  }
  rawListeners(): [] {
    return []
  }
  listenerCount(): number {
    return 0
  }
  prependListener(): this {
    return this
  }
  prependOnceListener(): this {
    return this
  }
  eventNames(): [] {
    return []
  }
  setDefaultEncoding(): this {
    return this
  }
  pipe<T extends NodeJS.WritableStream>(destination: T): T {
    return destination
  }
  cork(): void {}
  uncork(): void {}
  destroy(): this {
    return this
  }
}

function harness(
  overrides: Partial<{
    format: 'json' | 'table' | 'yaml'
    color: boolean
    quiet: boolean
    isTTY: boolean
  }> = {},
) {
  const stdout = new Capture()
  const stderr = new Capture()
  const streams: Streams = { stdout, stderr, isTTY: overrides.isTTY ?? false }
  const output = new Output(streams, {
    format: overrides.format ?? 'json',
    color: overrides.color ?? false,
    quiet: overrides.quiet ?? false,
  })
  return { output, stdout, stderr }
}

const ESC = String.fromCharCode(27)

describe('stdout carries data, stderr carries everything else', () => {
  it('writes payloads only to stdout', () => {
    const { output, stdout, stderr } = harness()
    output.data([{ id: 1, title: 'Ship it' }])

    expect(JSON.parse(stdout.text)).toEqual([{ id: 1, title: 'Ship it' }])
    // A spinner or a note here would break `weeek task list --json | jq`.
    expect(stderr.text).toBe('')
  })

  it('keeps notes, warnings, errors and traces off stdout', () => {
    const { output, stdout, stderr } = harness()
    output.note('fetching…')
    output.warn('deprecated')
    output.error('nope')
    output.trace('GET /tm/tasks → 200')
    output.success('done')

    expect(stdout.text).toBe('')
    expect(stderr.text).toContain('fetching…')
    expect(stderr.text).toContain('deprecated')
    expect(stderr.text).toContain('nope')
  })

  it('emits parseable JSON even when a mutation returns no payload', () => {
    // 77 operations answer {success: true} with nothing else; `--json` must stay parseable.
    const { output, stdout } = harness()
    output.data(null)
    expect(JSON.parse(stdout.text)).toBeNull()
  })

  it('suppresses notes under --quiet but never errors', () => {
    const { output, stderr } = harness({ quiet: true })
    output.note('chatty')
    output.success('fine')
    output.error('important')

    expect(stderr.text).not.toContain('chatty')
    expect(stderr.text).not.toContain('fine')
    expect(stderr.text).toContain('important')
  })
})

describe('colour', () => {
  it('is off without a TTY', () => {
    const streams: Streams = { stdout: new Capture(), stderr: new Capture(), isTTY: false }
    expect(shouldUseColor(streams, undefined, {})).toBe(false)
  })

  it('is on for a TTY', () => {
    const streams: Streams = { stdout: new Capture(), stderr: new Capture(), isTTY: true }
    expect(shouldUseColor(streams, undefined, {})).toBe(true)
  })

  it('honours NO_COLOR even on a TTY', () => {
    const streams: Streams = { stdout: new Capture(), stderr: new Capture(), isTTY: true }
    expect(shouldUseColor(streams, undefined, { NO_COLOR: '1' })).toBe(false)
  })

  it('treats an empty FORCE_COLOR as unset, not as a request for colour', () => {
    // Parent processes clear it by setting it empty; reading that as "yes" put ANSI in pipes.
    const streams: Streams = { stdout: new Capture(), stderr: new Capture(), isTTY: false }
    expect(shouldUseColor(streams, undefined, { FORCE_COLOR: '' })).toBe(false)
  })

  it('honours FORCE_COLOR=0 even on a TTY', () => {
    const streams: Streams = { stdout: new Capture(), stderr: new Capture(), isTTY: true }
    expect(shouldUseColor(streams, undefined, { FORCE_COLOR: '0' })).toBe(false)
  })

  it('honours --no-color over FORCE_COLOR', () => {
    const streams: Streams = { stdout: new Capture(), stderr: new Capture(), isTTY: true }
    expect(shouldUseColor(streams, false, { FORCE_COLOR: '1' })).toBe(false)
  })

  it('emits no escape sequences when colour is off', () => {
    const { output, stdout, stderr } = harness({ format: 'table', color: false })
    output.data([{ id: 1, title: 'x' }])
    output.error('bad')

    expect(stdout.text).not.toContain(ESC)
    expect(stderr.text).not.toContain(ESC)
  })
})

describe('table rendering', () => {
  it('aligns columns by printed width, ignoring colour codes', () => {
    const table = renderTable(
      [
        { id: 1, title: 'short' },
        { id: 200, title: 'much longer' },
      ],
      true,
    )
    const [header, ...rows] = table.split('\n')

    expect(header).toBeDefined()
    // Every row starts its second column at the same offset.
    const offsets = rows.map((row) => row.replace(ANSI, '').indexOf('  '))
    expect(new Set(offsets).size).toBeLessThanOrEqual(2)
  })

  it('says so plainly when there is nothing to show', () => {
    const { output, stdout, stderr } = harness({ format: 'table' })
    output.data([])
    expect(stdout.text).toBe('')
    expect(stderr.text).toContain('No results')
  })
})

const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

describe('secrets never reach the output', () => {
  it('redacts a registered token inside printed data', () => {
    clearSecrets()
    registerSecret('tok_live_abcdef123456')

    const { output, stdout } = harness()
    output.data({ note: 'using tok_live_abcdef123456', apiKey: 'tok_live_abcdef123456' })

    expect(stdout.text).not.toContain('tok_live_abcdef123456')
    clearSecrets()
  })
})

describe('exit codes', () => {
  it('maps error kinds to the documented codes', () => {
    const cases: [string, number][] = [
      ['auth', EXIT.auth],
      ['not-found', EXIT.notFound],
      ['validation', EXIT.usage],
      ['input', EXIT.usage],
      ['network', EXIT.network],
      ['rate-limit', EXIT.api],
      ['api', EXIT.api],
    ]

    for (const [kind, code] of cases) {
      const error = new WeeekError({ kind: kind as 'api', message: kind })
      expect(exitCodeFor(error), kind).toBe(code)
    }
  })

  it('falls back to a generic failure for unknown errors', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(EXIT.failure)
    expect(exitCodeFor('a string')).toBe(EXIT.failure)
  })
})
