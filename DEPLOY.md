# Deploy rex

Step-by-step guide for getting rex into production. You'll touch three places:

1. **GitHub** — create the GitHub App (where the bot "lives").
2. **Your VPS** — deploy `@rex/server` (receives OIDC tokens and issues installation tokens).
3. **Target repos** — install the App + add `.github/workflows/rex.yml`.

```
GitHub App ──webhook──▶ rex-server (YOUR VPS)
                          │ validates OIDC + allowlist
                          ▼
                       installation token (NO_PUSH / WRITE)
                          │
                          ▼
       .github/workflows/rex.yml in target repo ── rex-cli ── posts review
```

---

## 0. Prerequisites

- A GitHub account (personal or org).
- A VPS with:
  - **Docker** (recommended) or **Node 22 + pnpm 9**.
  - A domain or subdomain pointing at the VPS (e.g. `rex.yourvps.com`).
  - **TLS** (Caddy, Traefik, or nginx + certbot). GitHub delivers webhooks over HTTPS.
  - Port 443 open.
- An API key for at least one LLM provider:
  - Anthropic (`ANTHROPIC_API_KEY`) — recommended for starting out.
  - OpenAI (`OPENAI_API_KEY`).

---

## 1. Create the GitHub App

### 1.1 Personal vs org

- **Personal**: go to https://github.com/settings/apps → "New GitHub App".
- **Org**: go to `https://github.com/organizations/<ORG>/settings/apps` → "New GitHub App".

### 1.2 Fill in the form

| Field | Value |
|---|---|
| **GitHub App name** | `rex-<your-org>` (must be globally unique on GitHub). |
| **Homepage URL** | URL of the rex repo, or `https://rex.yourvps.com`. |
| **Webhook → Active** | ✅ checked |
| **Webhook URL** | `https://rex.yourvps.com/webhooks` |
| **Webhook secret** | Generate a long one: `openssl rand -hex 32`. **Save it** — you'll need it. |
| **Callback URL / Setup URL** | Leave blank. We don't use user OAuth. |

### 1.3 Repository permissions

| Permission | Level |
|---|---|
| Contents | **Read & write** |
| Issues | **Read & write** |
| Metadata | Read |
| Pull requests | **Read & write** |
| Workflows | Read & write *(optional — only if you want `/fix` to be able to edit workflows)* |

Account permissions: none needed.

### 1.4 Subscribe to events

Enable:

- ✅ Issue comments
- ✅ Pull request review comments
- ✅ Pull request reviews
- ✅ Installation target *(optional, for tracking)*

### 1.5 Where can this GitHub App be installed?

- **Only on this account** if it's personal or just your org.
- **Any account** if you want to offer it more broadly (the VPS allowlist still gates everything).

Click **Create GitHub App**. Note the **App ID** (shown at the top) — you'll need it for `rex.config.yml`.

### 1.6 Generate the private key

On your App's page, scroll to **Private keys** → **Generate a private key**.
Download the `.pem`. Keep it safe — it can't be recovered, only regenerated.

---

## 2. Deploy `rex-server` on your VPS

### 2.1 Clone the code

```bash
# on the VPS
git clone <your-rex-fork> /opt/rex
cd /opt/rex
```

### 2.2 Upload the private key

Copy it to the VPS (NEVER to the repo):

```bash
# from your local machine
scp ./rex-app.private-key.pem root@yourvps:/etc/rex/app.pem
ssh root@yourvps "chmod 600 /etc/rex/app.pem && chown root:root /etc/rex/app.pem"
```

### 2.3 Create `rex.config.yml`

```bash
cp packages/server/rex.config.example.yml /etc/rex/rex.config.yml
```

Edit `/etc/rex/rex.config.yml`:

```yaml
github_app:
  app_id: 123456                  # the App ID you noted
  private_key_path: /etc/rex/app.pem
  webhook_secret_env: REX_WEBHOOK_SECRET

allowlist:
  # Empty = unrestricted. Any non-empty list activates that gate.
  orgs:
    - fjimenez
  repos:
    - fjimenez/test-repo
  users:
    - fjimenez
    - collaborator1

oidc:
  audience: rex   # must match `oidc_audience` from the workflow

port: 3000
```

### 2.4 Environment variables

```bash
cat > /etc/rex/server.env <<'EOF'
REX_CONFIG_PATH=/etc/rex/rex.config.yml
REX_WEBHOOK_SECRET=<the-secret-you-generated-in-1.2>
# If you don't use private_key_path, uncomment and paste the PEM here:
# GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
EOF
chmod 600 /etc/rex/server.env
```

### 2.5 Run (option A — Docker)

```bash
cd /opt/rex
docker build -t rex-server -f packages/server/Dockerfile .

docker run -d \
  --name rex-server \
  --restart unless-stopped \
  --env-file /etc/rex/server.env \
  -v /etc/rex/app.pem:/etc/rex/app.pem:ro \
  -v /etc/rex/rex.config.yml:/etc/rex/rex.config.yml:ro \
  -p 127.0.0.1:3000:3000 \
  rex-server
```

### 2.5 Run (option B — systemd with pnpm directly)

```bash
cd /opt/rex
pnpm install --frozen-lockfile=false

cat > /etc/systemd/system/rex-server.service <<'EOF'
[Unit]
Description=rex review server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/rex
EnvironmentFile=/etc/rex/server.env
ExecStart=/usr/local/bin/pnpm --filter @rex/server start
Restart=on-failure
User=rex
Group=rex

[Install]
WantedBy=multi-user.target
EOF

useradd -r -s /usr/sbin/nologin rex
chown -R rex:rex /opt/rex
systemctl daemon-reload
systemctl enable --now rex-server
journalctl -u rex-server -f
```

### 2.6 Reverse proxy + TLS

**Caddy** (simplest):

```caddy
# /etc/caddy/Caddyfile
rex.yourvps.com {
    reverse_proxy 127.0.0.1:3000
}
```

`systemctl reload caddy`. Caddy obtains TLS automatically.

**Nginx** (alternative):

```nginx
server {
    listen 443 ssl http2;
    server_name rex.yourvps.com;
    # ssl_certificate / ssl_certificate_key via certbot
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### 2.7 Smoke test

```bash
curl https://rex.yourvps.com/healthz
# {"ok":true}

curl https://rex.yourvps.com/
# {"name":"rex","ok":true,"allowlist":{...}}
```

If you get this far, the server is alive. GitHub may take 1-2 minutes to deliver
the first webhook after App creation; on the App's page under **Advanced** you
can inspect every delivered webhook with its payload and status.

---

## 3. Install the App on target repos

On your GitHub App's page → **Install App** → pick the account and repos where
you want it active. You can pick **All repositories** or specific ones. **The
VPS allowlist is still the real gate**: even if the App is installed on every
repo in your org, only those listed in `rex.config.yml > allowlist.repos` (or
whose owner is in `allowlist.orgs`) will actually run rex.

---

## 4. Add the workflow in each target repo

### 4.1 Workflow file

Create `.github/workflows/rex.yml`:

```yaml
name: Rex

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  rex:
    if: github.event.sender.type != 'Bot'
    runs-on: ubuntu-latest
    # Required so orchestrate.ts can request an OIDC token and post comments:
    permissions:
      id-token: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - name: Checkout PR head
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
          fetch-depth: 0

      - name: Run rex
        uses: rex-org/rex/packages/action@main   # <- adjust to your fork/tag
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # See § 4.3 for the per-provider env-var/model pairs you can swap in:
          # OPENAI_API_KEY / DEEPSEEK_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
        with:
          model: anthropic/claude-sonnet-4-5
          mentions: "/review,/fix"
          rex_server_url: https://rex.yourvps.com
          # rex_repository: your-fork/rex     # if you have a fork
          # rex_ref: v0.1.0                   # pin to a tag
          # allowed_users: "fjimenez,colaborator1"  # extra per-repo allowlist
```

### 4.2 Available inputs

| Input | Default | Purpose |
|---|---|---|
| `model` | (required) | `provider/model`. E.g. `anthropic/claude-sonnet-4-5`, `openai/gpt-5`. |
| `mentions` | `/review,/fix` | Trigger phrases to look for in the comment. |
| `permissions` | per-command | `admin` / `write` / `any` / `CODEOWNERS` *(CODEOWNERS not implemented yet — Phase 4)*. |
| `token_permissions` | per-command | `NO_PUSH` / `WRITE` / JSON. `/review` uses `NO_PUSH`, `/fix` uses `WRITE`. |
| `rex_server_url` | (required) | URL of your VPS. |
| `oidc_audience` | `rex` | Must match `oidc.audience` on the server. |
| `rex_repository` / `rex_ref` | `rex-org/rex` / `main` | Pin which rex repo/tag to use. |
| `forks` | `true` | If `true`, silently skip PRs from forks (security). |
| `allowed_users` | (empty) | Optional CSV of logins. Stacks with the VPS allowlist. |

### 4.3 Provider configuration

rex supports four providers out of the box. **Pick one** (or wire up multiple
with different workflows). For each, you set one repo/org secret and two
`with:` inputs.

Secrets live in Settings → Secrets and variables → Actions. **Org-level secrets
are better** (DRY across repos), as long as the secret is accessible from the
repo's workflow.

#### Anthropic (Claude)

Get a key at https://console.anthropic.com. Recommended for starting out —
strongest tool-use and review quality today.

| Secret | Env var passed to the agent |
|---|---|
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` |

```yaml
- uses: rex-org/rex/packages/action@main
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    model: anthropic/claude-sonnet-4-5
    mentions: "/review,/fix"
    rex_server_url: https://rex.yourvps.com
```

Suggested models:
- `anthropic/claude-sonnet-4-5` — default, balanced cost/quality.
- `anthropic/claude-opus-4-7` — best quality for hard reviews, ~5× the price.
- `anthropic/claude-haiku-4-5` — cheap fallback for small PRs.

#### OpenAI

Get a key at https://platform.openai.com/api-keys.

| Secret | Env var passed to the agent |
|---|---|
| `OPENAI_API_KEY` | `OPENAI_API_KEY` |

```yaml
- uses: rex-org/rex/packages/action@main
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  with:
    model: openai/gpt-5
    mentions: "/review,/fix"
    rex_server_url: https://rex.yourvps.com
```

Suggested models:
- `openai/gpt-5` — top tier.
- `openai/gpt-4.1` — solid, cheaper.
- `openai/gpt-4o-mini` — fastest / cheapest; OK for small PRs.

#### DeepSeek

Get a key at https://platform.deepseek.com/api_keys. By far the cheapest of the
four; quality is good on logic-heavy reviews, less consistent on prose summary
quality.

| Secret | Env var passed to the agent |
|---|---|
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` |

```yaml
- uses: rex-org/rex/packages/action@main
  env:
    DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
  with:
    model: deepseek/deepseek-chat
    mentions: "/review,/fix"
    rex_server_url: https://rex.yourvps.com
```

Suggested models:
- `deepseek/deepseek-chat` — general-purpose.
- `deepseek/deepseek-reasoner` — thinks before answering; better for tricky
  logic bugs but slower and ~2× the cost.

#### Google (Gemini)

Get a key at https://aistudio.google.com/apikey.

| Secret | Env var passed to the agent |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | `GOOGLE_GENERATIVE_AI_API_KEY` |

```yaml
- uses: rex-org/rex/packages/action@main
  env:
    GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GOOGLE_GENERATIVE_AI_API_KEY }}
  with:
    model: google/gemini-2.5-pro
    mentions: "/review,/fix"
    rex_server_url: https://rex.yourvps.com
```

You can also write `model: gemini/gemini-2.5-pro` — both prefixes work.

Suggested models:
- `google/gemini-2.5-pro` — top tier; large context window helps on big PRs.
- `google/gemini-2.5-flash` — cheap and fast.

#### Mixing providers per command

Use two `rex` jobs in the same workflow with different mentions:

```yaml
jobs:
  rex-review:
    if: github.event.sender.type != 'Bot'
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: write, issues: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ github.event.pull_request.head.sha || github.sha }} }
      - uses: rex-org/rex/packages/action@main
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        with:
          model: deepseek/deepseek-chat
          mentions: "/review"
          rex_server_url: https://rex.yourvps.com

  rex-fix:
    if: github.event.sender.type != 'Bot'
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: write, issues: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ github.event.pull_request.head.sha || github.sha }} }
      - uses: rex-org/rex/packages/action@main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-opus-4-7
          mentions: "/fix"
          rex_server_url: https://rex.yourvps.com
```

Cheap model for everyday reviews, strong model only when applying fixes.

---

## 5. End-to-end test

### `/review` (read-only)
1. Open a test PR in a target repo (introduce an intentional bug: an obvious
   null deref, SQL injection, etc.).
2. Comment `/review` on the PR.
3. Within 10-20 seconds you should see:
   - The "Rex" workflow start under the **Actions** tab of the repo.
   - `Preflight orchestration` parsing the command and exchanging OIDC.
   - `Run rex-cli` running the agent loop.
   - A new review on the PR with summary + inline comments.

### `/fix` (modifies the PR branch)
By default requires `admin` on the repo (stricter gate than `/review`). If
you're not admin, set `permissions: write` on the workflow.

1. On the same PR (or a new one with a typo / missing null check / etc.) comment `/fix`.
2. Rex runs a loop with read tools **+** edit_file / create_file.
3. It calls `submit_fix({ summary, changes[] })`.
4. The CLI applies the edits against the runner's local checkout, runs
   `git commit -m "[rex] <summary>"` as `rex[bot]@users.noreply.github.com`
   and `git push origin HEAD:<PR-branch>` using the App token (NOT the workflow's
   `GITHUB_TOKEN` — this is key, because the App token push **does trigger
   downstream CI** while `GITHUB_TOKEN` pushes don't).
5. Posts a comment with a link to the commit and the list of changed files.

**`/fix` guarantees:**
- PRs from forks → no-op. Rex can't push to forks. Posts an explanatory comment.
- Ambiguous `oldStr` (appears >1 times in the file) → that edit is skipped with
  a reason; remaining edits still apply.
- If no edit applies, no commit / no push.
- The App token used for push is scoped to that single repo
  (`repositoryNames: [repo]`) with the `WRITE` preset (clamped server-side).

If nothing happens, check the repo's **Actions** tab first (the workflow should
have triggered) and then the server logs (`docker logs rex-server` or
`journalctl -u rex-server -f`).

---

## 6. Operations

### 6.1 Hot-edit the allowlist

Edit `/etc/rex/rex.config.yml` and restart:

```bash
docker restart rex-server
# or
systemctl restart rex-server
```

No code redeploy needed.

### 6.2 Rotate the webhook secret

1. Generate a new secret: `openssl rand -hex 32`.
2. Update `REX_WEBHOOK_SECRET` in `/etc/rex/server.env`.
3. On the App page → **General** → **Webhook secret** → paste the same value.
4. Restart the server.

### 6.3 JSON logs

Every log line is a single JSON object with `event:` as the discriminator
(`server_started`, `webhook`, `token_exchanged`, `exchange_denied`, etc.).
Easy to ship to Loki/Datadog/etc.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Workflow runs but `Preflight` fails with `OIDC exchange failed (401)` | The workflow's `oidc_audience` doesn't match the server's `oidc.audience`. | Make both match exactly (default `rex`). |
| `OIDC exchange failed (403): not allowed` | The repo/org/actor isn't in the VPS allowlist. | Add it to `rex.config.yml` and restart. |
| `OIDC exchange failed (404): app not installed` | The GitHub App isn't installed on that repo. | App page → Install → select the repo. |
| Workflow doesn't fire when commenting | The workflow lives on a non-default branch. GitHub only fires workflows that exist on the default branch. | Merge the workflow into `main` before testing. |
| `actor X lacks write` in `Preflight` | The commenting user doesn't have write access. | Expected for outside contributors. For PRs from forks, run is skipped anyway. |
| `submit_review` never called (30 step timeout) | The model goes on tangents. | Lower `max_steps`, revisit `REVIEW_SYSTEM_PROMPT`, or try a different model. |
| Inline comments outside the diff | The model picked lines not in the PR's hunks. | Rex falls back to issue comments labeled "outside diff". |
| Webhook received but no action | Phase 1 only logs the webhook. The real gate is the OIDC exchange when the workflow runs. This is normal. | — |
| GitHub shows "Last delivery: failed (timeout)" | The server takes too long, or the reverse proxy is blocking. | `curl https://rex.yourvps.com/webhooks -X POST -d '{}'` should return `400` quickly. |

---

## 8. Phase status

Phase 1 (✅ active): `/review` end-to-end.
Phase 2 (✅ active): `/fix` — apply edits + commit + push to the PR branch.
Phase 3 (🟡 partial): Anthropic, OpenAI, DeepSeek, Google — ✅. Moonshot/Kimi — pending.
Phase 4: CODEOWNERS, edit-in-place "rex working…" comment, `/stats`, tests.

Once Phase 3+ ships, you don't need to redeploy the target repo's workflow — only
the server VPS and the CLI (via `rex_ref` pin or `main`).
