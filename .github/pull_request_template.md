## What this changes

<!-- One or two sentences. If it fixes an issue, say "Fixes #123". -->

## Checklist

- [ ] `bun run lint && bun run typecheck && bun run test` pass
- [ ] `bun run gen` produces no diff (or the regenerated files are committed)
- [ ] `bun run docs:commands` run, if the command tree changed
- [ ] A changeset added (`bunx changeset`) for anything user-visible
- [ ] New behaviour has a test that fails without the change

## If this touches `spec/overrides.ts`

<!-- Say how you know. Which request did you send, and what came back? The `confidence` markers
     exist so that "assumed" and "verified against the API" stay distinguishable. -->
