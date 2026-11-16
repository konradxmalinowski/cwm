# Security policy

## Supported versions

CWM is pre-1.0. Only the latest published release receives security fixes. The development
branch is `main`.

| Version        | Supported |
| -------------- | --------- |
| latest release | yes       |
| older releases | no        |

Releases are unsigned (ADR 0003). Always verify downloads against the `SHA256SUMS` file attached
to the release (`docs/INSTALACJA.md`).

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue or discussion for a security problem.

Note for the maintainer: private vulnerability reporting must be enabled in the repository
settings (Settings, Code security) for this channel to work.

Please include the affected version or commit, the platform, steps to reproduce, and what an
attacker gains. Do not attach real tokens, credentials or personal configuration; use synthetic
data.

You can expect an acknowledgement within a few days. This is a small project maintained by one
person, so there is no formal SLA. Fixes are published in a new release and credited in the
changelog if you wish.

## Scope

In scope:

- **Engine launch.** `cwm start` and `cwm run` build a profile and start Claude Code. Ways to
  make them run something the user did not approve, bypass the managed policy through arguments,
  or leak the environment into the engine.
- **Approvals.** Bypassing or forging the approval of resources, packs, plugins and MCP servers
  (`~/.cwm/approvals/`), including hash mismatches that are accepted, and the lockfile checks.
- **Secret handling.** Secrets or tokens being read, copied into the registry, shown in diffs or
  logs, or written to disk where they should not be (import classifier, `envRef`).
- **Electron IPC and renderer hardening.** Sandbox, context isolation, the `app://` protocol,
  CSP, the IPC boundary between renderer and main, path handling (the renderer must only see
  opaque identifiers), and network blocking in the UI.
- **Writes outside the intended scope.** Anything that writes to the user's tool configuration
  without a plan, approval and backup, path traversal, or symlink escapes.
- **Supply chain of plugins from git.** Bypassing the pinned commit and tree verification.

Out of scope:

- Vulnerabilities in Claude Code, OpenAI Codex or other third-party tools themselves.
- Issues that need an attacker who already has write access to the user's home directory or
  `~/.cwm`, with no privilege gained by CWM.
- The unsigned-release warnings of macOS and Windows (a documented decision).
- Findings in development-only dependencies that are not part of the shipped app, unless they
  can be exploited through the app or its release pipeline.
