---
'weeek-cli': minor
---

First release. A CLI and terminal UI for WEEEK covering all 153 documented API operations,
generated from the API description so coverage is asserted by a test rather than claimed:

- 153 commands across 12 namespaces, plus `weeek api` as an escape hatch for anything unmapped
- `weeek ui` — an interactive kanban board with optimistic moves that roll back on rejection
- output contract: data on stdout, everything else on stderr, `--json|--table|--yaml`,
  `NO_COLOR`, documented exit codes, no prompting without a TTY
- token storage in a `0600` file or the system keychain, never in argv, with no silent fallback
  between backends
- request bodies validated locally with zod before the network; `--dry-run` everywhere
- shell completion for bash, zsh and fish, and `weeek schema --json` for wrappers and agents
