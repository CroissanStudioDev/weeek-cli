/**
 * Flag names the CLI owns.
 *
 * They live in their own module because two very different consumers need the same list: the
 * command builder, which must not register a second `--color`, and the code generator, which
 * renames API parameters that would collide. Keeping the list in the builder meant the
 * generator could not see it, and colliding fields were dropped instead — `--color` on ten
 * commands, reachable only through `--body`.
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  'profile',
  'token-file',
  'config-dir',
  'base-url',
  'output',
  'json',
  'color',
  'no-color',
  'quiet',
  'verbose',
  'yes',
  'dry-run',
  'no-validate',
  'env-file',
  'no-env-file',
  'body',
  'file',
  'output-file',
  'all-pages',
  'help',
  'version',
])

/**
 * The flag an API parameter is exposed under, prefixed when its own name is taken.
 *
 * `where` distinguishes the two namespaces so the renamed flag still says what it sets:
 * `--body-color` is a field of the request body, `--query-color` would be a filter.
 */
export function flagName(cli: string, where: 'body' | 'query'): string {
  return GLOBAL_FLAGS.has(cli) ? `${where}-${cli}` : cli
}
