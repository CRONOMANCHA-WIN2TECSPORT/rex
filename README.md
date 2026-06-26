# rex

Self-hosted PR review agent. Style of [ask-bonk](https://github.com/ask-bonk/ask-bonk),
deployment of [pr-agent](https://github.com/Codium-ai/pr-agent), TypeScript everywhere.

## What it does

- `/review` — leaves a polished PR review (summary + inline comments + commit-ready suggestions).
- `/fix` — applies fixes. On a **PR** it commits and pushes to the PR branch. On an **issue** it creates a new branch, implements the fix, and opens a PR that closes the issue.
- `/triage` — investigates a bug report on an **issue** by static analysis (read-only). Posts a verdict (`verified` / `reproduced` / `skipped`) with root-cause analysis and applies a `triage/*` label.

## Architecture

```
GitHub App ── webhook ──▶ rex-server (VPS, Hono)
                          │ verify sig + allowlist
                          │ OIDC token exchange endpoint
                          ▼
                   installation token
                          │
                          ▼
   Target repo .github/workflows/rex.yml runs the composite action,
   which installs OpenCode and runs `opencode github run` to post the review.
```

See `plan.md` for the full design.

## Packages

| Path | Description |
|---|---|
| `packages/shared` | Zod types, system prompts, GitHub helpers shared by server and action. |
| `packages/server` | Hono webhook + OIDC token-exchange server (runs on your VPS). |
| `packages/action` | Composite GitHub Action installed in target repos. Installs OpenCode and runs `opencode github run`. |

## Development

Requires Node 20+ and pnpm 9+.

```bash
pnpm install

# Type-check everything
pnpm typecheck

# Run the webhook server locally
pnpm dev:server
```

## Quickstart for users (once published)

1. Create a GitHub App with permissions: contents r/w, issues r/w, pull-requests r/w, metadata r.
2. Point its webhook at your VPS (`https://your-rex.example.com/webhooks`).
3. Drop `rex.config.yml` on the VPS with your allowlist.
4. In any repo you want rex on, install the App and add `.github/workflows/rex.yml` (see `packages/action/README.md`).
5. Add API key secrets (`ANTHROPIC_API_KEY`, etc.).
6. Comment `/review` on a PR, `/fix` on a PR or issue, or `/triage` on an issue.

## License

Apache-2.0.
