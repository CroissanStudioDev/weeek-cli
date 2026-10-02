# weeek-cli

## 0.1.0

### Minor Changes

- [`41a4035`](https://github.com/CroissanStudioDev/weeek-cli/commit/41a40353ab326766981cca063fa735c184eedb33) Thanks [@SergePolin](https://github.com/SergePolin)! - First release. A CLI and terminal UI for WEEEK covering all 153 documented API operations,
  generated from the API description so coverage is asserted by a test rather than claimed:

  - 153 commands across 12 namespaces, plus `weeek api` as an escape hatch for anything unmapped
  - `weeek ui` — an interactive kanban board with optimistic moves that roll back on rejection
  - output contract: data on stdout, everything else on stderr, `--json|--table|--yaml`,
    `NO_COLOR`, documented exit codes, no prompting without a TTY
  - token storage in a `0600` file or the system keychain, never in argv, with no silent fallback
    between backends
  - request bodies validated locally with zod before the network; `--dry-run` everywhere
  - shell completion for bash, zsh and fish, and `weeek schema --json` for wrappers and agents

### Patch Changes

- [`b0db2ff`](https://github.com/CroissanStudioDev/weeek-cli/commit/b0db2ff0c6d32a6a446f280c43b00adf7c75cf98) Thanks [@SergePolin](https://github.com/SergePolin)! - Fix the CLI doing nothing when installed from npm on Windows.

  The entry point decided whether it had been started as a program by comparing `import.meta.url`
  with `"file://" + process.argv[1]`. That concatenation only produces a valid URL on POSIX: on
  Windows argv[1] is `C:\dir\weeek.js` while the URL is `file:///C:/dir/weeek.js`, so the check
  never matched, `main()` never ran, and every command exited 0 having printed nothing. The paths
  are now compared as paths.
