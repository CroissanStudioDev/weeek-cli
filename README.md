# weeek-cli

Command-line client and terminal UI for the [WEEEK](https://weeek.net) task tracker, covering
**all 153 operations** of the public API.

> Unofficial project. Not affiliated with, endorsed by, or supported by WEEEK.
> The OpenAPI document it is built from was reconstructed from WEEEK's public documentation
> bundle — see [`spec/SPEC_PROVENANCE.md`](spec/SPEC_PROVENANCE.md).

```console
$ weeek task list --project-id 4 --completed --json | jq '.[0].title'
"Ship the release"

$ weeek ui                       # interactive kanban board in the terminal
```

## Why the coverage claim is checkable

The command tree is generated from the API description, not written by hand. A test asserts a
**bijection**: 153 documented operations ↔ 153 distinct, reachable commands. If WEEEK adds an
endpoint and the spec is refreshed, the test fails and names it. `weeek schema --json` dumps the
whole registry, so wrappers and agents can introspect the CLI instead of scraping `--help`.

## Install

```bash
npm install -g weeek-cli      # or: bun add -g weeek-cli, pnpm add -g weeek-cli
npx weeek-cli --help          # without installing
```

Standalone binaries (no Node required) are attached to each
[release](https://github.com/CroissanStudioDev/weeek-cli/releases), including a musl build for Alpine
and slim Docker images. Requires Node ≥ 22 when installed from npm.

## Authenticate

Get a token from your WEEEK workspace settings → **API**.

```bash
weeek auth login                       # hidden prompt, then verified against GET /user/me
printf '%s' "$TOKEN" | weeek auth login --stdin
weeek auth status
```

There is deliberately **no `--token <value>` flag**: a token passed as an argument lands in your
shell history and is visible in `ps` to every user on the machine. Use `--stdin`,
`--token-file <path>`, or the `WEEEK_TOKEN` environment variable (the right choice for CI).

Resolution order — first hit wins:

`--token-file` / `--stdin` → `WEEEK_TOKEN` → the storage backend declared in your config → error.

| Backend | Default | Notes |
| --- | --- | --- |
| `file` | yes | `~/.config/weeek/` at `0700`, config at `0600`; a world-readable file is **refused**, not warned about |
| `keychain` | opt-in | macOS Keychain / Secret Service / Windows Credential Manager, via `@napi-rs/keyring` |

If you declared `keychain` and it cannot be read (headless Linux, container, broken D-Bus), the
command fails and tells you to run `weeek auth login --backend file`. It never falls back
silently — a CLI that quietly writes your token somewhere else is worse than one that stops.
See [SECURITY.md](SECURITY.md).

## Using it

Path parameters are positional, everything else is a flag:

```bash
weeek project list --output table
weeek task get 8123
weeek task create --title "Write the changelog" --locations '[{"projectId":4,"boardColumnId":null}]'
weeek task complete 8123
weeek task list --project-id 4 --all-pages --json      # follows every page
weeek crm status deal list 12 --json | jq '.[] | {id, title, price}'
weeek attachment download f1e2d3 --output-file logo.png
```

Ten things worth knowing:

1. **stdout is data, stderr is everything else.** `weeek task list --json | jq` is always safe.
2. `--output json|table|yaml`, with `--json` as shorthand. JSON is a versioned contract.
3. Not a terminal? No colour, no prompts, no spinners — you get a clear error instead of a hang.
   `NO_COLOR` and `--no-color` are honoured.
4. `--dry-run` prints the request that would be sent, without sending it.
5. Request bodies are validated locally with zod before the network. `--no-validate` skips it —
   useful, since the reconstructed spec can be stricter than the API.
6. `--body '<json>'` is merged over the generated flags for anything they cannot express. A
   field whose API name is already a CLI flag is offered prefixed — `--body-color`, not
   `--color` — rather than being dropped.
7. `delete` commands confirm on a TTY and require `--yes` when not interactive.
8. `--verbose` traces requests to stderr — method, path, **query string**, status, timing —
   with the token masked. The query string is there so you can see how a filter was encoded.
9. `weeek api GET /tm/tasks --query projectId=4` is the escape hatch for anything unmapped.
10. `weeek completion zsh > ~/.zsh/completions/_weeek` — completions come from the same registry.

Exit codes: `0` ok · `1` general failure · `2` bad input · `3` auth · `4` not found · `5` API ·
`6` network.

**[Full command reference →](docs/COMMANDS.md)** (generated, 153 commands)

## `weeek ui`

An [Ink](https://github.com/vadimdemedes/ink)-based kanban board: columns from
`/tm/board-columns`, tasks from `/tm/tasks`. `h/j/k/l` or arrows to move the cursor, `H`/`L` to
move a card between columns, `c` to complete, `?` for help. Card moves are optimistic and roll
back visibly if the API rejects them, so the board never shows a state the server does not have.

## Use as a library

The HTTP core knows nothing about terminals and ships as its own entry point:

```ts
import { WeeekClient, OPERATIONS_BY_ID } from 'weeek-cli/api'

const client = new WeeekClient({ token: process.env.WEEEK_TOKEN! })
const tasks = await client.call(OPERATIONS_BY_ID.get('task.list')!, {
  path: {},
  query: { projectId: 4 },
})
```

## Where the spec and the API disagree

The spec is reconstructed and imperfect. Every correction lives in `spec/overrides.ts` with a
`confidence` marker instead of being silently patched, and `bun run spec:probe` re-checks the
encoding questions against a live workspace (read-only: GETs and one deliberate 404).

Verified against the live API:

| Question | Answer |
| --- | --- |
| Array query parameters | `tags[]=1&tags[]=2`. `tags=1,2` and repeated `tags=1&tags=2` are both rejected with 422. |
| Booleans | `0`/`1`. `completed=true` is rejected with 422 — it does not silently skip the filter. |
| `/crm/statuses{id}` | Really is a typo: `/crm/statuses/1` answers "Record not found", the unslashed form answers "route could not be found". |
| "Not found" | Arrives as **HTTP 400** with `{"code":1000001,"message":"Model not found"}`. The CLI reads the body code, so `weeek task get <missing>` still exits 4. |
| Validation errors | `{"success":false,"errors":{"field":["…"]}}`; the generic `message` alongside it does not name the field, so the field map wins. |
| Required filters | `GET /tm/board-columns` needs `boardId` even though the spec calls it optional. Checked locally, before the request. |

Still unverified: the 429 body and its `Retry-After` header (the client honours the header and
retries with backoff, but nobody has provoked one).

If any of this is wrong for your workspace, open an issue with the request you observed — each
one is a line in `spec/overrides.ts` plus a test.

## Development

```bash
bun install
bun run gen          # spec + overrides → generated registry, zod schemas, types
bun run typecheck && bun run lint && bun run test
bun run build        # dist/weeek.js + dist/core (SDK)
bun run build:binaries
bun run docs:commands                        # regenerate docs/COMMANDS.md
WEEEK_TOKEN=… bun run spec:probe             # re-check the encoding questions, read-only
```

Generated code is committed on purpose: installing must not require codegen or network access.
CI asserts `bun run gen` produces no diff, and that `src/core` never imports the CLI layer.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed [MIT](LICENSE).
