# Contributing

Thanks for looking. Issues and pull requests are welcome, including "this endpoint behaves
differently than the CLI assumes" reports — those are the most valuable kind here, because the
API description this project is built on was reconstructed rather than published.

## Setup

```bash
bun install                      # Bun ≥ 1.3; the published package targets Node ≥ 22
bun run gen                      # spec + overrides → src/core/api/generated/
bun run typecheck && bun run lint && bun run test
```

Before opening a PR, the same four commands should pass, plus `bun run docs:commands` if you
changed anything that affects the command tree.

## How the project is laid out

```
spec/       the OpenAPI document, its provenance, and overrides.ts (every known spec defect)
scripts/    refresh-spec, codegen, docs generation, build
src/core/   the SDK: HTTP, auth, config. Knows nothing about terminals, argv or colour
src/cli/    registry → Commander tree, naming, output contract, exit codes, completion
src/commands/  hand-written commands: auth, doctor, schema, api, completion, ui
src/tui/    the Ink board
tests/      parity (the coverage guarantee), contract, request shape
```

Two rules hold the shape together, and both are enforced rather than agreed:

- **`src/core` must not import `src/cli`, `src/commands`, `src/tui`, Commander, Ink, React or
  the prompt library.** Biome fails the build if it does. The core is also published as
  `weeek-cli/api`, so this is a public contract, not a preference.
- **`src/core/api/generated/**` is machine-written.** Do not edit it. CI runs `bun run gen` and
  fails on any diff. Fix the generator (`scripts/gen.ts`) or the override table instead.

## Changing behaviour that depends on the spec

The spec has known defects: a malformed path, an envelope key spelled `sucess`, tags that group
operations wrongly, undocumented error shapes. Every correction is a reviewable entry in
`spec/overrides.ts` with a `confidence` marker, not a silent patch.

If you verify one of the `assumed` entries against the live API, please say **what request you
sent and what came back** in the PR — the point of the marker is to record how we know.

## Adding a command

You usually do not. The 153 API commands are generated; adding a WEEEK endpoint means running
`bun run spec:refresh`, then `bun run gen`, and the parity test will tell you what changed.

Hand-written commands (`src/commands/`) are for things the API does not describe: auth,
diagnostics, introspection, the TUI. If you add one, it must respect the output contract —
data on stdout, everything else on stderr, no prompting without a TTY, an exit code from
`src/cli/exit-codes.ts`.

## Tests

New behaviour needs a test that would fail without it. Beyond that:

- anything touching request construction belongs in `tests/contract/request-shape.test.ts`,
  which is table-driven from the registry, so it covers new operations automatically;
- anything touching output or exit codes belongs in `tests/contract/output.test.ts`;
- never write a test that talks to the real API. The suite runs offline, in every PR, forever.

## Commits and releases

Conventional-ish commit subjects are appreciated but not enforced. Releases use
[changesets](https://github.com/changesets/changesets): run `bunx changeset` in your PR and
describe the change in a sentence a user would understand. Maintainers merge the release PR;
publishing happens from CI via npm Trusted Publishing.

### For maintainers: the first publish cannot use OIDC

npm configures a trusted publisher on a package's settings page, and that page does not exist
until the package does — unlike PyPI, there are no "pending publishers"
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). Bootstrap once:

1. `npm publish` the `0.0.0` placeholder from a clean checkout, authenticated with a granular
   token. (`package.json` is already at `0.0.0`; the first changeset takes it to `0.1.0`.)
2. On npmjs.com → the package → **Settings → Trusted Publisher**, point it at
   `CroissanStudioDev/weeek-cli` and the workflow file `release.yml`. Both must match exactly.
3. Revoke the granular token. Every release after this one goes through CI with no long-lived
   secret in the repository.

Note also that pushing to `main` does not publish: `.changeset/*` entries make the action open a
"Version Packages" PR, and merging *that* is what triggers the publish.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
