/**
 * Builds the command tree from the generated registry.
 *
 * Every one of the 153 operations becomes a command here, mechanically. That is what makes
 * "full API coverage" a property of the build rather than a maintenance promise — and it is
 * asserted by tests/parity.test.ts.
 *
 * Cold start matters at this size, so the tree is lazy in two stages: only the ~12 top-level
 * namespaces are created up front, their subcommands are materialised when a namespace is
 * actually used, and the handler (plus the client, prompts and Ink) is imported only when a
 * command runs.
 */

import { Command, Option } from 'commander'
import { PAGINATOR_FLAG } from '../../spec/overrides.ts'
import type { OperationMeta, ParamMeta } from '../core/api/generated/operations.ts'
import { NAMESPACES, OPERATIONS } from '../core/api/generated/operations.ts'

export { GLOBAL_FLAGS } from './global-flags.ts'

export interface CommandContext {
  operation: OperationMeta
  /** Positional path arguments, in declaration order. */
  args: string[]
  options: Record<string, unknown>
}

export type OperationRunner = (context: CommandContext) => Promise<void>

function flagFor(param: ParamMeta): string {
  // `all-pages` is the CLI paginator; `--all` stays a passthrough because GET /tm/tasks really
  // does declare a query parameter called `all` (overrides: DEFECT 6).
  const name = param.cli
  if (param.type === 'boolean') return `--${name}`
  return `--${name} <${param.type === 'array' ? 'value...' : param.type}>`
}

function describe(param: ParamMeta): string {
  const parts = [param.description?.replace(/\s+/g, ' ').trim()].filter(Boolean)
  if (param.enum) parts.push(`one of: ${param.enum.join(', ')}`)
  if (param.wire === 'numeric-bool') parts.push('sent as 0/1')
  return parts.join(' — ')
}

/**
 * Applies an operation's arguments, options and action to an existing Command.
 *
 * Split out from `buildOperationCommand` because a namespace can *be* an operation: `weeek me`
 * is a single-segment command, and creating a child for it would produce `weeek me me`.
 */
export function configureOperation(
  command: Command,
  operation: OperationMeta,
  run: OperationRunner,
): Command {
  const summary = operation.summary || `${operation.method} ${operation.path}`
  command.description(`${summary}  (${operation.method} ${operation.path})`)

  const pathParams = operation.params.filter((p) => p.in === 'path')
  for (const param of pathParams) command.argument(`<${param.cli}>`, describe(param) || param.name)

  for (const param of operation.params) {
    if (param.in !== 'query') continue
    const option = new Option(flagFor(param), describe(param))
    if (param.enum) option.choices(param.enum.map(String))
    command.addOption(option)
  }

  if (operation.body) {
    if (operation.body.contentType === 'multipart') {
      command.option('--file <path...>', 'file(s) to upload')
    }
    for (const field of operation.body.fields) {
      const structured = field.type === 'array' || field.type === 'object'
      const placeholder = structured ? '<json>' : '<value>'
      const hint = [structured ? 'JSON' : field.type, field.required ? 'required' : null]
        .filter(Boolean)
        .join(', ')
      // Enum members go in the description rather than into Option.choices(): the spec's body
      // enums are sometimes narrower than what the API accepts, and a wrong `choices` list
      // refuses a value locally with no way past it except `--body`.
      const values = field.enum ? ` — one of: ${field.enum.join(', ')}` : ''
      command.option(`--${field.cli} ${placeholder}`, `${field.name} (${hint})${values}`)
    }
    // Escape hatch for anything the flattened flags cannot express (nested objects, arrays).
    command.option('--body <json>', 'raw JSON request body, merged over the flags above')
  }

  if (operation.paginated) {
    command.option(`--${PAGINATOR_FLAG}`, 'fetch every page, not just the first')
  }

  if (operation.binary) {
    command.option('--output-file <path>', 'write to a file instead of stdout')
  }

  command.action(async (...actionArgs: unknown[]) => {
    // Commander passes positionals, then the options object, then the Command instance.
    const options = actionArgs[actionArgs.length - 2] as Record<string, unknown>
    const args = actionArgs.slice(0, pathParams.length).map((value) => String(value))
    await run({ operation, args, options })
  })

  return command
}

/** Turns one operation into a leaf command named after its final verb. */
export function buildOperationCommand(operation: OperationMeta, run: OperationRunner): Command {
  const verb = operation.command.at(-1) as string
  return configureOperation(new Command(verb), operation, run)
}

/**
 * Attaches all commands for one namespace.
 *
 * Intermediate groups (`task watcher …`) are created on demand so the tree shape follows the
 * registry rather than a hand-maintained list.
 */
export function buildNamespace(namespace: string, run: OperationRunner): Command {
  const root = new Command(namespace)
  const groups = new Map<string, Command>([['', root]])

  const operations = OPERATIONS.filter((op) => op.command[0] === namespace)

  for (const operation of operations) {
    // A single-segment command is the namespace itself (`weeek me`), not a child of it.
    if (operation.command.length === 1) {
      configureOperation(root, operation, run)
      continue
    }

    // command = [namespace, ...groups, verb]
    const middle = operation.command.slice(1, -1)

    let parent = root
    let key = ''
    for (const segment of middle) {
      key = key === '' ? segment : `${key} ${segment}`
      let group = groups.get(key)
      if (!group) {
        group = new Command(segment)
        group.description(`${segment} operations`)
        parent.addCommand(group)
        groups.set(key, group)
      }
      parent = group
    }

    parent.addCommand(buildOperationCommand(operation, run))
  }

  // A namespace that is only a container should print its help rather than silently doing
  // nothing when invoked bare.
  if (operations.length > 0 && !operations.some((op) => op.command.length === 1)) {
    root.description(`${namespace} commands (${operations.length})`)
  }

  return root
}

/** Every top-level namespace, built eagerly only as far as its own node. */
export function buildRegistry(run: OperationRunner): Command[] {
  return NAMESPACES.map((namespace) => buildNamespace(namespace, run))
}

/** Maps a command path back to its operation — used by completion and `weeek schema`. */
export function findOperation(path: string[]): OperationMeta | undefined {
  const key = path.join('.')
  return OPERATIONS.find((op) => op.id === key)
}
