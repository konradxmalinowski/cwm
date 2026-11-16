# Contributing to CWM

Thanks for helping. CWM (Claude Workspace Manager) is a local desktop app (Electron + Angular)
and a `cwm` command line tool for managing AI coding tool configuration. This file covers how to
get a change merged. The project documentation under `docs/` is written in Polish; issues and
pull requests may be in English or Polish.

The project is released under the [MIT License](LICENSE). By submitting a contribution you agree
that it is licensed under MIT. For a large change, please open an issue first.

## Setup

1. Fork `konradxmalinowski/cwm` and clone your fork.
2. Use Node.js 24 (`.nvmrc`; `engines` in `package.json` requires `>=24.0.0`).
3. Install and run:

```sh
npm ci
npm run dev        # build and start the desktop app
```

`better-sqlite3` ships prebuilt binaries, so no C++ toolchain is needed unless a prebuild is
missing for your platform (`npm run rebuild:native`).

To try the CLI from source:

```sh
npm run build:main
node dist/cli/index.js --help
```

## Checks to run before opening a PR

CI runs the same commands. Run them locally first:

| Command                   | What it checks                                               |
| ------------------------- | ------------------------------------------------------------ |
| `npm run lint`            | ESLint (including layer boundary rules) and Prettier         |
| `npm run typecheck`       | `tsc --noEmit` for main, preload and tests                   |
| `npm run test:boundaries` | proves the layer rules block forbidden imports               |
| `npm test`                | unit, contract, integration and property tests (Vitest)      |
| `npm run test:e2e`        | Playwright against the built app (run `npm run build` first) |

`npm run format` fixes Prettier issues. E2E tests are slow; if your change does not touch the
UI, Electron main or preload, `lint`, `typecheck`, `test:boundaries` and `test` are the minimum.

## Layer rules

The code is hexagonal. The rules are enforced by lint, not by convention (`CLAUDE.md`,
`docs/ARCHITECTURE.md`, `docs/ROADMAP.md` section 1):

- `src/core/` does not import `electron`, `node:fs`, `better-sqlite3` or Angular.
- `src/adapters/` does not import `node:fs` or `node:child_process`.
- `src/renderer/` does not import from `main/`, `infra/`, `adapters/` or `preload/`.
- `src/cli/` does not import from `main/`, `renderer/` or `preload/`, and nothing imports `cli/`.

Do not silence a boundary rule with a disable comment. If a rule gets in your way, open an
issue and explain why.

Security invariants that every change must keep (`docs/ARCHITECTURE.md`, security model):

- The renderer never receives a filesystem path, only an opaque identifier.
- Nothing from an import is executed.
- No change to user configuration without explicit approval and a backup.
- Tests never write to a real user configuration. Fixtures are synthetic (`acme-*` names).
  Never copy real configuration, tokens or personal data into tests, docs or issues.

Before proposing a change of technology or approach, check `docs/adr/` for an existing decision.
A new significant decision gets a new ADR; do not edit an accepted one to reverse it.

## Branches and commits

- Branch from `main`. Name branches `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`
  or `test/<slug>`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(cwm): ...`, `fix(main): ...`, `docs: ...`, `test: ...`, `chore: ...`. Use the imperative
  mood and keep the subject under about 72 characters.
- User-visible changes get an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog,
  in Polish like the rest of the file).
- Update the docs that describe the behavior you changed (`README.md`, `docs/CLI.md`, ADRs).

## Pull request process

1. Open the PR against `main` and fill in the template.
2. CI must be green: quality gates, the secret scan and the four-platform build matrix.
3. A maintainer reviews. Address comments with new commits; they are squashed or merged by the
   maintainer.
4. Do not bump `package.json` version or edit release sections of the changelog. Releases are
   cut by the maintainer (`docs/RELEASING.md`).

## Reporting bugs and vulnerabilities

Use the issue templates for bugs and feature requests. Do not report security problems in a
public issue; see [`SECURITY.md`](SECURITY.md).
