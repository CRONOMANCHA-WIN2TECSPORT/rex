# rex

Self-hosted PR review agent. Style of [ask-bonk](https://github.com/ask-bonk/ask-bonk),
deployment of [pr-agent](https://github.com/Codium-ai/pr-agent), TypeScript everywhere.

## What it does

- `/review` — leaves a polished PR review (summary + inline comments + commit-ready suggestions).
- `/fix` — applies the fixes for you (commits + push to the PR branch).

## Architecture

```
GitHub App ── webhook ──▶ rex-server (VPS, Hono)
                          │ verify sig + allowlist
                          │ OIDC token exchange endpoint
                          ▼
                   repository_dispatch
                          │
                          ▼
   Target repo .github/workflows/rex.yml runs the composite action,
   which runs rex-cli (Vercel AI SDK agent loop) and posts the review.
```

See `plan.md` for the full design.

## Packages

| Path | Description |
|---|---|
| `packages/shared` | Zod types, prompts, GitHub helpers shared across server and cli. |
| `packages/server` | Hono webhook + OIDC token-exchange server (runs on your VPS). |
| `packages/action` | Composite GitHub Action installed in target repos. |
| `packages/cli` | The agent CLI that runs inside the Action and posts the review. |

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
6. Comment `/review` on a PR.

## License

Apache-2.0.
