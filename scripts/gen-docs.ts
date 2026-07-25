/**
 * Regenerates the command reference from the registry.
 *
 * The table is written between markers in docs/COMMANDS.md and README.md rather than by hand:
 * a hand-maintained list of 153 commands is wrong the day after it is written, and a README
 * that disagrees with the binary is worse than no README.
 *
 * `--check` verifies the files are up to date without writing — that is the CI job.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NAMESPACES, OPERATIONS } from '../src/core/api/generated/operations.ts'

const root = resolve(import.meta.dirname, '..')
const BEGIN = '<!-- BEGIN GENERATED COMMANDS -->'
const END = '<!-- END GENERATED COMMANDS -->'

/** Human-facing titles for namespaces whose bare name reads oddly in a heading. */
const TITLES: Record<string, string> = {
  crm: 'CRM (deals, contacts, organizations, funnels)',
  me: 'Current user',
  ws: 'Workspace',
}

function usage(operationIndex: number): string {
  const operation = OPERATIONS[operationIndex] as (typeof OPERATIONS)[number]
  const positionals = operation.params
    .filter((p) => p.in === 'path')
    .map((p) => `<${p.cli}>`)
    .join(' ')
  return `weeek ${operation.command.join(' ')}${positionals ? ` ${positionals}` : ''}`
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function commandTable(): string {
  const lines: string[] = []

  lines.push(
    `${OPERATIONS.length} commands across ${NAMESPACES.length} namespaces, generated from ` +
      '`spec/weeek-openapi.json` — every operation the API documents has exactly one command ' +
      '(asserted by `tests/parity.test.ts`).',
    '',
  )

  for (const namespace of NAMESPACES) {
    const indices = OPERATIONS.map((op, index) => ({ op, index })).filter(
      ({ op }) => op.command[0] === namespace,
    )
    if (indices.length === 0) continue

    lines.push(`### \`${namespace}\` — ${TITLES[namespace] ?? `${namespace} operations`}`, '')
    lines.push('| Command | Endpoint | What it does |', '| --- | --- | --- |')

    for (const { op, index } of indices) {
      const summary = escapePipes(op.summary || '—')
      const notes: string[] = []
      if (op.paginated) notes.push('`--all-pages`')
      if (op.binary) notes.push('binary')
      if (op.body?.contentType === 'multipart') notes.push('`--file`')
      const suffix = notes.length > 0 ? ` _(${notes.join(', ')})_` : ''

      lines.push(`| \`${usage(index)}\` | \`${op.method} ${op.path}\` | ${summary}${suffix} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** Replaces the marked block, leaving everything else in the file untouched. */
function splice(source: string, block: string, file: string): string {
  const start = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (start === -1 || end === -1) {
    throw new Error(`${file} is missing the ${BEGIN} / ${END} markers`)
  }
  return `${source.slice(0, start + BEGIN.length)}\n\n${block}\n${source.slice(end)}`
}

const check = process.argv.includes('--check')
const table = commandTable()
const targets = ['docs/COMMANDS.md']

let stale = false
for (const relative of targets) {
  const path = resolve(root, relative)
  const current = readFileSync(path, 'utf8')
  const next = splice(current, table, relative)

  if (current === next) continue
  if (check) {
    stale = true
    console.error(`${relative} is out of date — run \`bun run docs:commands\``)
    continue
  }
  writeFileSync(path, next)
  console.log(`updated ${relative}`)
}

if (stale) process.exit(1)
if (!check) console.log(`${OPERATIONS.length} commands documented`)
