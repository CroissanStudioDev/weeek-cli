/**
 * Explicit corrections applied on top of `weeek-openapi.json` during codegen.
 *
 * The vendored spec is kept byte-identical to what the docs bundle serves (see
 * SPEC_PROVENANCE.md), so every defect and every cosmetic rename lives here instead —
 * visible, reviewable, and easy to drop when upstream fixes something.
 */

/** Marks a fact that was verified against the live API rather than assumed. */
export type Confidence = 'verified' | 'assumed'

/**
 * DEFECT 1 — a missing slash. The spec declares `/crm/statuses{id}` for three operations
 * (GET/PUT/DELETE funnel status). Every other path in the document is well-formed, so this
 * is a typo rather than a real route.
 *
 * VERIFIED against the live API (`bun run spec:probe`):
 *   GET /crm/statuses/1  → 404 {"message":"Record not found"}          ← the route exists
 *   GET /crm/statuses1   → 404 {"message":"The route … could not be found."}
 * The two 404s say different things: one is a missing record, the other a missing route.
 */
export const PATH_FIXES: Record<string, { to: string; confidence: Confidence }> = {
  '/crm/statuses{id}': { to: '/crm/statuses/{id}', confidence: 'verified' },
}

/**
 * DEFECT 5 — response envelopes differ per operation: `{success, tasks}`, `{success, task}`,
 * `{success, deals, hasMoreDeals}`, `{success, data, hasMore}`. One operation even spells the
 * flag `sucess`. The payload is therefore "the one key that is not bookkeeping", and these are
 * the bookkeeping keys.
 */
export const ENVELOPE_META_KEYS = new Set(['success', 'sucess', 'hasMore', 'hasMoreDeals'])

/** Keys that carry "there is another page" information, in the order we prefer to read them. */
export const HAS_MORE_KEYS = ['hasMore', 'hasMoreDeals'] as const

/**
 * DEFECT 9 — `GET /ws/attachments/{file_id}` returns file bytes, not JSON. It must skip
 * envelope unwrapping and the json/table/yaml formatters entirely.
 */
export const BINARY_OPERATIONS = new Set(['GET /ws/attachments/{file_id}'])

/**
 * DEFECT 6 — pagination is not universal. Only `GET /tm/tasks` declares `perPage`/`offset`/`all`,
 * so `--all-pages` is offered only where the parameters actually exist. Detected from the spec;
 * listed here for documentation.
 *
 * Note the name clash: `GET /tm/tasks` has a query parameter genuinely called `all`. The CLI
 * paginator is therefore `--all-pages`, and `--all` stays a passthrough to the API.
 */
export const PAGINATOR_FLAG = 'all-pages'

/**
 * DEFECT 8 — the `tags` query parameter is `array of string` with no `style`/`explode`, so the
 * wire format is undefined by the document.
 *
 * VERIFIED against the live API (`bun run spec:probe`) — only the bracket form is accepted:
 *   GET /tm/tasks?tags[]=1&tags[]=2  → 200
 *   GET /tm/tasks?tags=1,2           → 422
 *   GET /tm/tasks?tags=1&tags=2      → 422
 * The rejected forms fail loudly rather than silently not filtering, which is the good case.
 */
export const QUERY_ARRAY_FORMAT: {
  style: 'brackets' | 'repeat' | 'comma'
  confidence: Confidence
} = { style: 'brackets', confidence: 'verified' }

/**
 * Booleans on the wire are `0`/`1`, not `true`/`false`.
 *
 * The spec types these parameters as `boolean` but the description of `GET /tm/tasks?completed`
 * says outright: "The parameter assumes values of 0 or 1, instead of false or true".
 *
 * VERIFIED against the live API (`bun run spec:probe`), on a workspace with 20 open tasks:
 *   ?completed=1     → 200, 0 tasks   ← filters
 *   ?completed=0     → 200, 20 tasks  ← filters
 *   ?completed=true  → 422
 *   ?completed=false → 422
 *
 * Applied to every boolean query parameter, since the API is uniform on this point.
 */
export const BOOLEAN_WIRE_FORMAT: { style: 'numeric' | 'literal'; confidence: Confidence } = {
  style: 'numeric',
  confidence: 'verified',
}

/**
 * DEFECT 11 — the spec understates which query parameters are mandatory.
 *
 * `GET /tm/board-columns` declares `boardId` as `required: false`, but the API answers
 * `422 {"errors":{"boardId":["The field is required."]}}` without it (verified with
 * `bun run spec:probe`-style calls against a live workspace). Left alone, `weeek board-column
 * list` fails on its first use with a message naming a wire parameter instead of a flag.
 *
 * Keyed by `METHOD /path` **as the spec writes it**, i.e. before PATH_FIXES is applied — codegen
 * builds the lookup key from the raw path. An entry for `GET /crm/statuses/{id}` would therefore
 * never match; it would have to be keyed `GET /crm/statuses{id}`.
 *
 * Lists parameter names the API actually requires. Add an entry only with an observed response —
 * this table makes commands stricter, so a wrong guess here blocks a request the API would have
 * accepted.
 */
export const REQUIRED_QUERY_OVERRIDES: Record<
  string,
  { params: string[]; confidence: Confidence }
> = {
  'GET /tm/board-columns': { params: ['boardId'], confidence: 'verified' },
}

/**
 * DEFECT 7 — response payloads are only half-typed: 73 of 153 operations describe their payload
 * inline, the rest are a bare `{"type": "object"}`. Meanwhile `components.schemas` does define
 * the real entities — the paths simply never `$ref` them.
 *
 * This maps `METHOD /path` to the component schema that actually describes the payload, which
 * recovers typing for the untyped operations without hand-writing a single interface.
 */
export const RESPONSE_SCHEMAS: Record<string, string> = {
  'GET /tm/tasks': 'Task',
  'GET /tm/tasks/{id}': 'Task',
  'POST /tm/tasks': 'Task',
  'PUT /tm/tasks/{id}': 'Task',
  'GET /tm/projects': 'Project',
  'GET /tm/projects/{id}': 'Project',
  'POST /tm/projects': 'Project',
  'GET /tm/boards': 'Board',
  'POST /tm/boards': 'Board',
  'GET /tm/board-columns': 'BoardColumn',
  'POST /tm/board-columns': 'BoardColumn',
  'GET /tm/custom-fields': 'CustomField',
  'POST /tm/custom-fields': 'CustomField',
  'GET /ws/tags': 'Tag',
  'GET /ws/tags/{id}': 'Tag',
  'POST /ws/tags': 'Tag',
  'GET /ws': 'Workspace',
  'GET /ws/members': 'User',
  'GET /user/me': 'User',
  'GET /crm/deals/{id}': 'Deal',
  'GET /crm/statuses/{statusId}/deals': 'Deal',
  'GET /crm/contacts': 'Contact',
  'GET /crm/contacts/{id}': 'Contact',
  'GET /crm/organizations': 'Organization',
  'GET /crm/organizations/{id}': 'Organization',
  'GET /crm/funnels': 'Funnel',
  'GET /crm/funnels/{id}': 'Funnel',
}

/**
 * DEFECT 10 — path parameter names are inconsistent across the spec (`{dealId}` vs `{id}`,
 * `{contactId}` vs `{contactsId}`, `{task_id}` vs `{taskId}`). Positional argument names are
 * therefore normalised rather than derived from the parameter string.
 */
export const PATH_PARAM_NAMES: Record<string, string> = {
  contactsId: 'contact-id',
  contactId: 'contact-id',
  organizationId: 'organization-id',
  funnelId: 'funnel-id',
  statusId: 'status-id',
  dealId: 'deal-id',
  taskId: 'task-id',
  task_id: 'task-id',
  deal_id: 'deal-id',
  board_id: 'board-id',
  project_id: 'project-id',
  funnel_id: 'funnel-id',
  custom_field_id: 'custom-field-id',
  time_entry_id: 'time-entry-id',
  file_id: 'file-id',
  emailId: 'email-id',
  phoneId: 'phone-id',
  addressId: 'address-id',
  id: 'id',
}

/**
 * Cosmetic command renames.
 *
 * The path-derived naming in `cli/naming.ts` already yields 153 distinct commands with zero
 * collisions — these only fix names that are correct but read badly. Keyed by `METHOD /path`
 * (after PATH_FIXES) and holding the complete replacement command path.
 */
export const COMMAND_NAMES: Record<string, string[]> = {
  // A resource with no name of its own: the path is just `/ws`.
  'GET /ws': ['workspace', 'info'],
  // `/user/me` is a singleton, not a collection — "me list" would be nonsense.
  'GET /user/me': ['me'],

  // Uploads are actions, and the plural read as a collection to the path parser.
  'POST /tm/tasks/{task_id}/attachments': ['task', 'attachment', 'upload'],
  'POST /crm/deals/{deal_id}/attachments': ['crm', 'deal', 'attachment', 'upload'],
  // Downloads bytes rather than JSON — see BINARY_OPERATIONS.
  'GET /ws/attachments/{file_id}': ['attachment', 'download'],

  // Bare nouns as verbs ("task board") say nothing about what happens.
  'POST /tm/tasks/{id}/board': ['task', 'set-board'],
  'POST /tm/tasks/{id}/board-column': ['task', 'set-column'],
  'POST /tm/tasks/{taskId}/parent': ['task', 'set-parent'],
  'PUT /crm/deals/{id}/funnel': ['crm', 'deal', 'set-funnel'],
  'PUT /crm/deals/{id}/status': ['crm', 'deal', 'set-status'],
}

/**
 * DEFECT 3 — `PUT /crm/deals/{id}` and `PATCH /crm/deals/{id}` are two distinct operations on
 * one path. Both are kept, with distinct verbs, so neither is silently dropped. This is handled
 * by the method→verb mapping (`put`→`update`, `patch`→`patch`) and asserted by the parity test;
 * no override is required. Documented here so the collision is not "fixed" away later.
 */

/**
 * DEFECT 2 — `tags` in the spec are unreliable for grouping. For example
 * `DELETE /tm/projects/{project_id}/custom-fields/{cf}/options/{id}` is tagged `Board`.
 * Namespaces are therefore derived from the path; spec tags are ignored entirely.
 * No override table needed — the path-based rule fixes every misfiled operation at once.
 */

/**
 * DEFECT 4 — only HTTP 200 is documented and there are no error schemas. Error handling is
 * hand-written in `core/api/errors.ts` and the envelope shape is discovered at runtime.
 *
 * Two shapes are now **verified** against the live API (`bun run spec:probe`), with no
 * workspace token required — both are reachable unauthenticated:
 *
 *   401  {"success": false, "code": 2000000, "message": "Unauthenticated."}
 *   404  {"success": false, "message": "The route public/v1/… could not be found."}
 *
 * So: a numeric `code` accompanies `message`, and the API honours `Accept: application/json`
 * even for framework-level routing errors — without it, an unknown route answers an HTML error
 * page. The client always sends that header for this reason.
 *
 * Still unverified (they need a real workspace): 422 validation bodies and the 429 response
 * together with its `Retry-After` header. `core/api/errors.ts` probes several plausible shapes,
 * including Laravel's `{errors: {field: [...]}}`.
 */
export const ERROR_ENVELOPE_HINT = {
  successFlag: 'success',
  messageKeys: ['message', 'error'],
  /** Present on at least 401; carried into WeeekError for support conversations. */
  codeKey: 'code',
}
