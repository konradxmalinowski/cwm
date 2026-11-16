## Why

<!-- The problem or motivation. Link the issue if there is one: Fixes #123. -->

## What changes

<!-- Short list of changes. Mention any change in user-visible behavior. -->

## Verification

<!-- How you checked it. Tick what you ran. -->

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:boundaries`
- [ ] `npm test`
- [ ] `npm run test:e2e` (if UI, main or preload changed)

## Checklist

- [ ] Commits follow Conventional Commits
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` for user-visible changes
- [ ] Docs updated (`README.md`, `docs/`, ADR if a decision changed)
- [ ] No real configuration, tokens, company names or personal data in code, tests or fixtures
- [ ] Layer boundary rules are not bypassed with disable comments

## Rollback

<!-- How to undo this change if it causes problems. -->
