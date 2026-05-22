# @rex/action

The composite GitHub Action installed in target repos.

## Usage in a target repo

`.github/workflows/rex.yml`:

```yaml
name: Rex
on:
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }

jobs:
  rex:
    if: github.event.sender.type != 'Bot'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }}

      - uses: rex-org/rex/packages/action@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY, DEEPSEEK_API_KEY, GOOGLE_API_KEY, MOONSHOT_API_KEY...
        with:
          model: anthropic/claude-sonnet-4-5
          mentions: "/review,/fix"
          rex_server_url: https://rex.your-vps.example.com
          # Optional: extra actor allowlist on top of the VPS-side allowlist.
          # allowed_users: "fjimenez,colaborador1"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `model` | (required) | `provider/model` string for the agent. |
| `mentions` | `/review,/fix` | Comma-separated trigger phrases. |
| `permissions` | per-command | `admin` / `write` / `any` / `CODEOWNERS`. |
| `token_permissions` | per-command | `NO_PUSH` / `WRITE` / JSON. |
| `rex_server_url` | (required) | URL of your rex server. |
| `oidc_audience` | `rex` | Must match `oidc.audience` in `rex.config.yml`. |
| `rex_ref` / `rex_repository` | `main` / `rex-org/rex` | Pin the rex revision. |
| `forks` | `true` | Skip fork PRs. |
| `allowed_users` | (empty) | Optional extra actor allowlist. |

## How it works

1. Mentions check (bash regex).
2. Sets up Node 22 + pnpm 9, checks out rex itself into `_rex/`.
3. `orchestrate.ts` parses the command (`/review` or `/fix`), validates the
   actor's permission via `getCollaboratorPermissionLevel`, fetches the PR head
   SHA, then calls `POST {rex_server_url}/auth/exchange_github_app_token` with
   the workflow's OIDC token. The server checks its allowlist; if allowed,
   returns a scoped installation token. The token is written to `$GITHUB_ENV`
   as `REX_APP_TOKEN`.
4. Git remote URL is rewritten with the App token so any pushes (`/fix`)
   trigger downstream workflows.
5. Runs `rex-cli`, which loads the agent loop and posts the review/fix.
6. `finalize.ts` runs `always()` — if the CLI failed, posts a "rex failed"
   comment with a link to the run.
