/**
 * `weeek.env` — parsing, discovery and the boundaries that keep discovery from surprising you.
 *
 * The dangerous part of this feature is not reading a file; it is deciding *which* file, from a
 * directory nobody typed. Most of what follows is about the edges of that decision.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findEnvFile, parseEnvFile } from './env-file.ts'

function tree(): string {
  return mkdtempSync(join(tmpdir(), 'weeek-env-'))
}

function write(dir: string, contents: string): string {
  const path = join(dir, 'weeek.env')
  writeFileSync(path, contents, { mode: 0o600 })
  return path
}

describe('parsing', () => {
  it('reads the plain form', () => {
    expect(parseEnvFile('WEEEK_TOKEN=abc123')).toEqual({ WEEEK_TOKEN: 'abc123' })
  })

  it('tolerates the shapes a person actually writes', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        '   ',
        'export WEEEK_TOKEN=abc123',
        'WEEEK_BASE_URL = "https://stand.example/api"   ',
        "WEEEK_PROFILE='work'",
        'IGNORED=whatever',
      ].join('\r\n'),
    )

    expect(parsed).toEqual({
      WEEEK_TOKEN: 'abc123',
      WEEEK_BASE_URL: 'https://stand.example/api',
      WEEEK_PROFILE: 'work',
      IGNORED: 'whatever',
    })
  })

  it('drops a trailing comment but keeps a # that belongs to the value', () => {
    expect(parseEnvFile('WEEEK_TOKEN=abc123   # the work token')).toEqual({
      WEEEK_TOKEN: 'abc123',
    })
    // A quoted value is taken whole: `#` inside quotes is data, not a comment.
    expect(parseEnvFile('WEEEK_BASE_URL="https://example/api#v1"')).toEqual({
      WEEEK_BASE_URL: 'https://example/api#v1',
    })
  })

  it('ignores lines that are not assignments rather than throwing', () => {
    // A malformed line in a credentials file must not take the whole CLI down.
    expect(parseEnvFile('this is not an assignment\nWEEEK_TOKEN=abc')).toEqual({
      WEEEK_TOKEN: 'abc',
    })
  })
})

describe('discovery', () => {
  it('finds the file in the working directory', () => {
    const dir = tree()
    const path = write(dir, 'WEEEK_TOKEN=abc')

    expect(findEnvFile(dir)).toBe(path)
  })

  it('walks up from a subdirectory', () => {
    const dir = tree()
    const path = write(dir, 'WEEEK_TOKEN=abc')
    const deep = join(dir, 'apps', 'web')
    mkdirSync(deep, { recursive: true })

    expect(findEnvFile(deep)).toBe(path)
  })

  it('stops at the repository root', () => {
    // The boundary that makes the feature safe: a file belonging to a parent checkout, or to
    // whatever directory you happen to keep your projects in, is never this project's.
    const outer = tree()
    write(outer, 'WEEEK_TOKEN=belongs-to-someone-else')

    const repo = join(outer, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const inside = join(repo, 'src')
    mkdirSync(inside, { recursive: true })

    expect(findEnvFile(inside)).toBeUndefined()
  })

  it('prefers the nearest file when there are two', () => {
    const outer = tree()
    write(outer, 'WEEEK_TOKEN=outer')
    const inner = join(outer, 'inner')
    mkdirSync(inner, { recursive: true })
    const nearest = write(inner, 'WEEEK_TOKEN=inner')

    expect(findEnvFile(inner)).toBe(nearest)
  })

  it('never climbs past the home directory', () => {
    // The file is *above* home. Without the boundary the walk would reach it and quietly apply
    // one token to every project on the machine.
    const above = tree()
    write(above, 'WEEEK_TOKEN=applies-to-everything')

    const home = join(above, 'home')
    const below = join(home, 'projects', 'thing')
    mkdirSync(below, { recursive: true })

    expect(findEnvFile(below, home)).toBeUndefined()
    // Same tree, no boundary declared: it is found — so the assertion above is about the
    // boundary and not about the file being absent.
    expect(findEnvFile(below, join(above, 'elsewhere'))).toBe(join(above, 'weeek.env'))
  })

  it('returns nothing when there is nothing', () => {
    expect(findEnvFile(tree())).toBeUndefined()
  })
})
