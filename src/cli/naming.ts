/**
 * Turns an API path + method into a command path.
 *
 * The spec's own `tags` are unusable for grouping — `DELETE /tm/projects/{id}/custom-fields/…`
 * is tagged `Board`, for one. So the namespace comes from the path, which fixes every misfiled
 * operation at once and happens to yield a bijection: 153 operations → 153 distinct commands,
 * asserted by tests/parity.test.ts.
 */

import { COMMAND_NAMES, PATH_PARAM_NAMES } from '../../spec/overrides.ts'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Top-level path segments that name an API area, not a resource. */
const AREAS = new Set(['tm', 'crm', 'ws', 'user'])

/** Areas that stay in the command path. `tm`/`ws` resources are addressed directly. */
const KEPT_AREAS = new Set(['crm'])

export function singularize(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('sses') || word.endsWith('ses') || word.endsWith('xes'))
    return word.slice(0, -2)
  if (word.endsWith('s')) return word.slice(0, -1)
  return word
}

/** Normalised, kebab-case name for a positional argument (see overrides: DEFECT 10). */
export function argName(pathParam: string): string {
  return (
    PATH_PARAM_NAMES[pathParam] ??
    pathParam
      .replace(/_/g, '-')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase()
  )
}

export interface PathShape {
  area: string | null
  /** Resource chain, e.g. ['board', 'custom-field', 'option']. */
  resources: { name: string; hasId: boolean }[]
  /** Path parameters in order of appearance. */
  params: string[]
  /** Trailing action verb, e.g. 'complete' or 'transfer-to-board'. */
  action: string | null
}

/**
 * A trailing literal is a sub-COLLECTION (so the verb comes from the HTTP method) when either
 *   - some other path extends it with a parameter (`/…/custom-fields` → `/…/custom-fields/{id}`), or
 *   - the same path carries more than one method (POST+DELETE = an attach/detach pair).
 *
 * Otherwise it is an ACTION verb (`/tm/tasks/{id}/complete`).
 *
 * Getting this wrong is what produced 12 name collisions in an earlier draft: sub-collections
 * like `watchers` and `tags` were being treated as action verbs, which erased the method and
 * collapsed each attach/detach pair onto one command.
 */
function isCollection(
  absolutePath: string,
  allPaths: readonly string[],
  methodCount: ReadonlyMap<string, number>,
): boolean {
  if ((methodCount.get(absolutePath) ?? 0) > 1) return true
  return allPaths.some((other) => other.startsWith(`${absolutePath}/{`))
}

export function parsePath(
  path: string,
  allPaths: readonly string[],
  methodCount: ReadonlyMap<string, number>,
): PathShape {
  const segments = path.split('/').filter(Boolean)
  const area = segments[0] && AREAS.has(segments[0]) ? (segments.shift() as string) : null

  const resources: { name: string; hasId: boolean }[] = []
  const params: string[] = []
  let action: string | null = null
  let walked = area ? `/${area}` : ''

  for (const [i, segment] of segments.entries()) {
    walked += `/${segment}`

    if (segment.startsWith('{')) {
      params.push(segment.slice(1, -1))
      const last = resources.at(-1)
      if (last) last.hasId = true
      continue
    }

    const isLast = i === segments.length - 1
    const afterAnId = resources.at(-1)?.hasId === true
    if (isLast && afterAnId && !isCollection(walked, allPaths, methodCount)) {
      action = segment
    } else {
      resources.push({ name: singularize(segment), hasId: false })
    }
  }

  return { area, resources, params, action }
}

export function verbFor(
  method: HttpMethod,
  shape: PathShape,
  hasCollectionDelete: boolean,
): string {
  if (shape.action) return shape.action

  const onItem = shape.resources.at(-1)?.hasId === true
  switch (method) {
    case 'GET':
      return onItem ? 'get' : 'list'
    case 'POST':
      // POST paired with a DELETE on the same collection is an attach/detach pair.
      return !onItem && hasCollectionDelete ? 'add' : 'create'
    case 'PUT':
      return 'update'
    case 'PATCH':
      // Kept distinct from PUT: both exist on /crm/deals/{id} (overrides: DEFECT 3).
      return 'patch'
    case 'DELETE':
      return onItem ? 'delete' : 'remove'
  }
}

/** Full command path, e.g. ['board', 'custom-field', 'option', 'move']. */
export function commandFor(
  method: HttpMethod,
  path: string,
  allPaths: readonly string[],
  methodCount: ReadonlyMap<string, number>,
  collectionDeletes: ReadonlySet<string>,
): string[] {
  const override = COMMAND_NAMES[`${method} ${path}`]
  if (override) return [...override]

  const shape = parsePath(path, allPaths, methodCount)
  const prefix = shape.area && KEPT_AREAS.has(shape.area) ? [shape.area] : []
  const verb = verbFor(method, shape, collectionDeletes.has(path))

  return [...prefix, ...shape.resources.map((r) => r.name), verb]
}
