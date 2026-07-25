# Security

## Reporting a vulnerability

Report privately through GitHub's **Security → Report a vulnerability** form on this
repository. Please do not open a public issue for anything that could expose someone's token.

Include what you did, what happened, and the version (`weeek --version`). Expect an
acknowledgement within a week. This is a volunteer project; there is no bounty.

For vulnerabilities in the WEEEK service itself, contact WEEEK — this project is unaffiliated
and cannot act on them.

## The threat model, stated plainly

**WEEEK issues one long-lived personal access token per user. It has no scopes, no expiry, and
no refresh flow** — the API description contains exactly one security scheme (HTTP bearer) on
all 153 operations. There is no OAuth flow to implement.

The consequences are worth being explicit about:

- Anyone holding the token has **your full access to the workspace**, for reading and writing,
  until you revoke it manually in WEEEK's settings.
- Short expiry and narrow scopes normally reduce the blast radius of a leaked credential. Here
  neither exists, so the only mitigations available are **storing it carefully** and **never
  printing it**. That is what this CLI actually implements.
- If you suspect a token leaked: revoke it in WEEEK workspace settings → API. Rotating on this
  side is not enough.

## What the CLI does about it

**Never in argv.** There is no `--token <value>` flag. Arguments land in shell history and are
readable by any process on the machine via `ps`. Accepted instead: `--stdin`,
`--token-file <path>`, `WEEEK_TOKEN`.

**File storage.** `$WEEEK_CONFIG_DIR`, else `$XDG_CONFIG_HOME/weeek`, else `~/.config/weeek`
(`%APPDATA%\weeek` on Windows). The directory is created `0700` and the config file `0600`. On
read, permissions are checked: a config readable by other users **fails the command** instead of
emitting a warning nobody reads. (POSIX only; Windows relies on the user profile ACL.)

**Keychain storage** is opt-in via `weeek auth login --backend keychain`, backed by
`@napi-rs/keyring` (macOS Keychain, Secret Service, Windows Credential Manager). `keytar` is not
used — it is archived and unmaintained.

**No silent fallback.** The chosen backend is recorded in the config. If it is `keychain` and
the keyring cannot be reached, the command fails with instructions. Silently writing the token
to a file the user did not ask for is the dominant failure mode in CLIs that do this, and it
means a credential ends up somewhere the user does not know to protect or clean up.

**Not in the standalone binaries.** The compiled binaries do not contain the keychain backend at
all. Bun's `--compile` embeds native `.node` modules unreliably, so shipping it would produce a
backend that appears to exist and fails at runtime. Binaries use the file backend or
`WEEEK_TOKEN`. This is a designed absence, not a degraded mode.

**Redaction has one implementation.** `src/core/auth/redact.ts` masks registered secrets and
bearer-shaped strings in every output path: `--verbose` traces, error messages, `weeek api`
dumps, `weeek doctor`. `weeek auth status` shows the last four characters and the source, never
the token. A contract test asserts the full token appears in neither stdout nor stderr under
`--verbose`.

**CI and containers** should use `WEEEK_TOKEN` and touch neither the keychain nor a config file.

## Supply chain

- Published to npm with **Trusted Publishing (OIDC)** — no long-lived `NPM_TOKEN` exists in this
  repository's secrets — and with Sigstore provenance attestation. Verify with
  `npm audit signatures` after installing.
- Generated code is committed and CI asserts it matches the spec, so a tampered generated file
  cannot pass review unnoticed.
- Runtime dependencies are deliberately few. `@napi-rs/keyring` is the only native one and is
  optional.
