# Where `weeek-openapi.json` comes from

**This is not an official WEEEK artifact.** WEEEK does not publish an OpenAPI document.
This file was reconstructed from the public documentation site and is vendored here so
the build is reproducible and offline.

## Extraction

`developers.weeek.net` is a [Zudoku](https://zudoku.dev) single-page app. It does not serve
the spec at any stable URL — `/openapi.json`, `/swagger.json` and friends all return the SPA
shell. Instead the document is inlined into a content-hashed build chunk. Recovering it takes
two hops:

1. `GET https://developers.weeek.net/` → the HTML references one hashed client bundle,
   `/assets/entry.client-<hash>.js`.
2. `GET` that bundle → it lists its lazy chunks, one of which is `./weeek.yaml-<hash>.js`.
3. `GET /assets/weeek.yaml-<hash>.js` → an ES module containing a *dehydrated* spec: a shared
   `$ref` lookup table (`const t = Array.from({length: 63}, () => ({}))`) whose entries are
   populated by reference, followed by `const a = {openapi: "3.1.1", ...}`.
4. Evaluate the module and serialise the binding to JSON.

Both hashes change on every docs deploy, which is why this is automated rather than a bookmark:

```bash
bun run spec:refresh   # scripts/refresh-spec.ts
```

## What is in it

- OpenAPI **3.1.1**, 97 paths, **153 operations**, 63 component schemas.
- Base URL `https://api.weeek.net/public/v1`.
- One security scheme: `{"type": "http", "scheme": "bearer"}`, repeated on every operation.
  There is no OAuth flow, no refresh token, no scopes and no `webhooks` section.

## Known defects

The document is machine-readable but dirty. Every defect is handled explicitly in
[`overrides.ts`](./overrides.ts) rather than by silently patching this file — this file is kept
byte-identical to what the docs bundle serves, so that `spec:refresh` produces a clean diff and
upstream fixes are visible.

Do not hand-edit `weeek-openapi.json`.

## Drift

CI re-runs the extraction on a schedule and diffs the result. New or changed endpoints show up
as a failing parity test rather than as silently missing commands.
