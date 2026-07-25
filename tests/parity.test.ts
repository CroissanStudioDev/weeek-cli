/**
 * The coverage guarantee, made executable.
 *
 * "Full API coverage" is worth nothing as a promise in a README — here it is a bijection
 * asserted against the spec: every operation in the document maps to exactly one command, and
 * every command maps back to exactly one operation.
 *
 * Counting alone would not be enough. If two operations collapsed onto the same command name,
 * one would silently overwrite the other and the count would still look right — so the
 * distinctness assertion is the one that actually protects coverage.
 *
 * When the spec is refreshed and WEEEK has added endpoints, this test fails and names them.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { PATH_FIXES } from '../spec/overrides.ts'
import { buildRegistry } from '../src/cli/registry.ts'
import { OPERATIONS } from '../src/core/api/generated/operations.ts'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

interface RawSpec {
  paths: Record<string, Record<string, { summary?: string } | undefined>>
}

const spec: RawSpec = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../spec/weeek-openapi.json'), 'utf8'),
)

/** Every operation the spec declares, as `METHOD /path` after path corrections. */
const specOperations: string[] = Object.entries(spec.paths).flatMap(([rawPath, item]) => {
  const path = PATH_FIXES[rawPath]?.to ?? rawPath
  return HTTP_METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path}`)
})

describe('spec ↔ command parity', () => {
  it('covers every operation the spec declares', () => {
    const registered = new Set(OPERATIONS.map((op) => `${op.method} ${op.path}`))
    const missing = specOperations.filter((key) => !registered.has(key))

    expect(missing, `${missing.length} spec operation(s) have no command`).toEqual([])
  })

  it('registers no command that the spec does not declare', () => {
    const declared = new Set(specOperations)
    const extra = OPERATIONS.map((op) => `${op.method} ${op.path}`).filter((k) => !declared.has(k))

    expect(extra, `${extra.length} command(s) point at unknown operations`).toEqual([])
  })

  it('maps operations to commands one-to-one', () => {
    // The important half: a name collision would let one operation overwrite another while
    // the total count stayed correct.
    const byCommand = new Map<string, string[]>()
    for (const op of OPERATIONS) {
      const key = op.command.join(' ')
      byCommand.set(key, [...(byCommand.get(key) ?? []), `${op.method} ${op.path}`])
    }

    const collisions = [...byCommand]
      .filter(([, ops]) => ops.length > 1)
      .map(([command, ops]) => `${command} ← ${ops.join('  |  ')}`)

    expect(collisions, 'two operations share one command name').toEqual([])
    expect(byCommand.size).toBe(specOperations.length)
  })

  it('keeps ids unique and aligned with command paths', () => {
    const ids = OPERATIONS.map((op) => op.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const op of OPERATIONS) expect(op.id).toBe(op.command.join('.'))
  })

  it('has the operation count the spec analysis established', () => {
    // A guard against a generator that silently drops or duplicates work: if this number
    // changes, the spec changed, and that should be a deliberate, reviewed diff.
    expect(specOperations.length).toBe(153)
    expect(OPERATIONS.length).toBe(153)
  })
})

describe('known spec defects stay fixed', () => {
  it('normalises the funnel-status path that is missing a slash', () => {
    // DEFECT 1: the spec declares `/crm/statuses{id}`.
    const malformed = OPERATIONS.filter((op) => /\w\{/.test(op.path))
    expect(malformed.map((op) => op.path)).toEqual([])

    const statusOps = OPERATIONS.filter((op) => op.path === '/crm/statuses/{id}')
    expect(statusOps.map((op) => op.method).sort()).toEqual(['DELETE', 'GET', 'PUT'])
  })

  it('keeps PUT and PATCH on /crm/deals/{id} as separate commands', () => {
    // DEFECT 3: both exist; a generator that picked one would silently lose an operation.
    const put = OPERATIONS.find((op) => op.method === 'PUT' && op.path === '/crm/deals/{id}')
    const patch = OPERATIONS.find((op) => op.method === 'PATCH' && op.path === '/crm/deals/{id}')

    expect(put?.command).toEqual(['crm', 'deal', 'update'])
    expect(patch?.command).toEqual(['crm', 'deal', 'patch'])
  })

  it('groups by path rather than by the spec tags', () => {
    // DEFECT 2: this operation is tagged `Board` but belongs to projects.
    const op = OPERATIONS.find(
      (o) =>
        o.method === 'DELETE' &&
        o.path === '/tm/projects/{project_id}/custom-fields/{custom_field_id}/options/{id}',
    )
    expect(op?.command[0]).toBe('project')
  })

  it('offers pagination only where the spec declares it', () => {
    // DEFECT 6: only GET /tm/tasks has perPage + offset, despite 13 list endpoints.
    const paginated = OPERATIONS.filter((op) => op.paginated)
    expect(paginated.map((op) => op.id)).toEqual(['task.list'])
  })

  it('marks the attachment download as binary and gives it no envelope', () => {
    // DEFECT 9: returns file bytes, so it must skip envelope unwrapping and the formatters.
    const binary = OPERATIONS.filter((op) => op.binary)
    expect(binary.map((op) => op.id)).toEqual(['attachment.download'])

    // Structural, not a convention the client has to remember: a leftover envelope key here
    // would let a reasonable implementation unwrap file bytes as JSON.
    for (const op of binary) {
      expect(op.envelopeKey, op.id).toBeNull()
      expect(op.hasMoreKey, op.id).toBeNull()
    }
  })

  it('records the documented success status, which is not always 200', () => {
    // Reading only the 200 response made these two look like they had no envelope at all.
    const noContent = OPERATIONS.filter((op) => op.successStatus === 204)
    expect(noContent.map((op) => op.id).sort()).toEqual([
      'task.location.add',
      'task.location.remove',
    ])
  })

  it('encodes boolean query parameters as 0/1', () => {
    // The spec types them `boolean`, but GET /tm/tasks?completed documents 0/1 explicitly.
    // Sending true/false would be accepted and silently not filter.
    const booleans = OPERATIONS.flatMap((op) =>
      op.params.filter((p) => p.type === 'boolean').map((p) => ({ id: op.id, p })),
    )
    expect(booleans.length).toBeGreaterThan(0)
    for (const { id, p } of booleans) expect(p.wire, `${id}:${p.name}`).toBe('numeric-bool')
  })

  it('resolves envelope keys generically, including the misspelled flag', () => {
    // DEFECT 5: payload = the one key that is not bookkeeping.
    expect(OPERATIONS.find((op) => op.id === 'task.list')?.envelopeKey).toBe('tasks')
    expect(OPERATIONS.find((op) => op.id === 'task.get')?.envelopeKey).toBe('task')
    expect(OPERATIONS.find((op) => op.id === 'crm.status.deal.list')?.hasMoreKey).toBe(
      'hasMoreDeals',
    )
    // `success` / `sucess` / `hasMore*` must never be mistaken for the payload.
    const meta = ['success', 'sucess', 'hasMore', 'hasMoreDeals']
    for (const op of OPERATIONS) expect(meta).not.toContain(op.envelopeKey)
  })

  it('normalises inconsistent path parameter names', () => {
    // DEFECT 10: {contactId} vs {contactsId}, {task_id} vs {taskId}.
    const phone = OPERATIONS.find((op) => op.id === 'crm.contact.phone.create')
    expect(phone?.params.find((p) => p.in === 'path')?.cli).toBe('contact-id')

    const email = OPERATIONS.find((op) => op.id === 'crm.contact.email.create')
    expect(email?.params.find((p) => p.in === 'path')?.cli).toBe('contact-id')
  })
})

describe('every operation is reachable in the built tree', () => {
  // The assertions above hold over an *array*. This one holds over the thing a user actually
  // invokes: a command that failed to attach, or a namespace root whose action was overwritten
  // by a subcommand, would pass every count-based check above.
  const tree = buildRegistry(async () => {})

  /** Walks the tree, mapping each command path to its description. */
  const nodes = new Map<string, string>()
  const walk = (command: Command, path: string[]) => {
    nodes.set(path.join(' '), command.description())
    for (const child of command.commands) {
      if (child.name() === 'help') continue
      walk(child, [...path, child.name()])
    }
  }
  for (const namespace of tree) walk(namespace, [namespace.name()])

  it.each(OPERATIONS.map((op) => [op.command.join(' '), op] as const))('%s', (path, operation) => {
    const description = nodes.get(path)
    expect(description, `no command node at "weeek ${path}"`).toBeDefined()
    // configureOperation stamps the signature; a bare group node would not carry it.
    expect(description, `"weeek ${path}" is a group, not a wired operation`).toContain(
      `(${operation.method} ${operation.path})`,
    )
  })

  it('adds no leaf that is not an operation', () => {
    const operationPaths = new Set(OPERATIONS.map((op) => op.command.join(' ')))
    const leaves = [...nodes]
      .filter(([, description]) => / \((GET|POST|PUT|PATCH|DELETE) \//.test(description))
      .map(([path]) => path)

    expect(leaves.filter((path) => !operationPaths.has(path))).toEqual([])
    expect(leaves.length).toBe(153)
  })
})

describe('registry is well-formed', () => {
  it('declares every path placeholder as a path parameter', () => {
    for (const op of OPERATIONS) {
      const placeholders = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
      const declared = op.params.filter((p) => p.in === 'path').map((p) => p.name)
      expect(new Set(declared), `${op.id} (${op.path})`).toEqual(new Set(placeholders))
    }
  })

  it('gives every operation a command and a summary-bearing id', () => {
    for (const op of OPERATIONS) {
      expect(op.command.length, op.id).toBeGreaterThan(0)
      expect(
        op.command.every((segment) => /^[a-z0-9-]+$/.test(segment)),
        op.id,
      ).toBe(true)
    }
  })
})
