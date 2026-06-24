# CLAUDE.md

Context for AI assistants working on rex. Read this before making changes.

## What rex is

Self-hosted PR review agent modelled after [ask-bonk](https://github.com/ask-bonk/ask-bonk)
but with the VPS server replacing Cloudflare Workers. Three commands:

- `/review` — leaves a polished PR review with inline comments + GitHub-suggestion blocks.
- `/fix` — applies fixes by writing files, committing, and pushing. On a **PR**
  it pushes to the PR branch; on an **issue** it creates a `rex/fix-issue-<n>`
  branch, pushes it, and opens a PR that closes the issue.
- `/triage` — investigates a bug-report **issue** (code-only, no execution), posts a
  root-cause report, and stamps one `triage/*` label. Read-only; never pushes.

rex picks the OpenCode agent per command — `/review`→`auto-reviewer`,
`/fix`→`auto-implementer`, `/triage`→`auto-triage` (exported as `REX_AGENT` from
`orchestrate.ts`; the workflow's `agent:` input is only a fallback). The target
repo supplies those agents under `.opencode/agents/`.

Like ask-bonk, the agent itself is **[OpenCode](https://opencode.ai)** —
installed globally inside the Action, invoked as `opencode github run`.
Rex's own code is just the VPS gate plus the orchestrator that builds the
prompt and exchanges the OIDC token.

Design references: `plan.md` (full design), `DEPLOY.md` (deployment guide),
`README.md` (user-facing intro). Sibling repos `../ask-bonk/` and `../pr-agent/`
are checked out as reference material — read them when porting patterns.

## Mental model: the three components

This is the most important thing to understand. The system is intentionally
split across three runtime environments:

```
[YOUR VPS]                   [GITHUB]                  [TARGET REPO'S GH ACTIONS]
┌────────────────┐  webhook  ┌────────┐  workflow run  ┌─────────────────────┐
│ @rex/server    │◀──────────│ GitHub │───────────────▶│ @rex/action runs    │
│ (Hono)         │           │  App   │                │  ├─ orchestrate.ts  │
│                │  OIDC     │        │                │  ├─ opencode (loop) │
│  /webhooks     │◀──────────┼────────┼────────────────│  └─ finalize.ts     │
│  /auth/exchange│──token───▶│        │                │                     │
└────────────────┘           └────────┘                └─────────────────────┘
```

1. **`@rex/server` runs on your VPS** — a Hono app that only does two things:
   verifies webhook signatures (logging-only, Phase 1) and exchanges OIDC tokens
   from GitHub Actions for scoped installation tokens (this is the **real**
   gate). It does NOT analyze code, does NOT call LLMs, does NOT clone repos.

2. **`@rex/action` is a composite GitHub Action** — installed via
   `uses: rex-org/rex/packages/action@main` in target repos. It runs in the
   user's GitHub-hosted runner. It does the plumbing:
   - Parses the slash command from the comment.
   - Validates the commenter's permission via `getCollaboratorPermissionLevel`.
   - Requests an installation token from the VPS server (OIDC exchange).
   - Builds the system prompt + PR-context guard + user prompt and exports it
     as `REX_PROMPT` → `PROMPT` for OpenCode to consume.
   - Rewrites git's stored credentials so pushes use the App token (not
     `GITHUB_TOKEN`) — see "Push must use App token" below.
   - Installs `opencode-ai` globally and runs `opencode github run`.
   - Posts a failure comment on `always()` if OpenCode exited non-zero.

3. **OpenCode is the agent** — installed as a global binary inside the Action
   (`bun install -g opencode-ai@latest`). It reads `MODEL`, `PROMPT`, `AGENT`,
   `VARIANT`, `PR_NUMBER`, `ISSUE_NUMBER`, `MENTIONS`, `GITHUB_TOKEN` from the
   environment, performs the agent loop against the checkout, and posts the
   review (or applies the fix and pushes) using its built-in tools.

**Why this split?** The VPS never sees the code. OpenCode has full filesystem
access (because it's inside `actions/checkout`) and we don't pay for VPS
compute per PR. The VPS is just a thin gate that controls who can use rex.

**Why OpenCode instead of a homegrown loop?** Early rex iterations shipped a
Vercel AI SDK agent with custom `submit_review`/`submit_fix` terminator tools.
We swapped to OpenCode for the same reason ask-bonk does: it already covers
multi-provider tool-use, filesystem tools, git operations, and GitHub review
posting. The trade-off is that we lose the strict Zod terminator contract —
the model's GitHub posting is no longer schema-validated. The prompts in
`packages/shared/src/prompts.ts` are the only steering we have.

## Repo layout

```
packages/
├── shared/   Zod schemas (commands, config), prompts (REVIEW/FIX system prompts), GitHub helpers, sanitize.ts (input-hardening)
├── server/   Hono app + config loader + allowlist + OIDC validation
└── action/   action.yml + orchestrate.ts (preflight) + post_review.ts (review publisher) + post_triage.ts (triage publisher) + finalize.ts
```

Each package is a pnpm workspace member with its own `package.json`. They all
share `tsconfig.base.json` and use ESM (`"type": "module"`, `.js` import
suffixes in TS source because `tsx` and TS bundler resolution require them).

OpenCode is installed at runtime inside the Action — there is no `packages/cli`.
The action checks out the rex repo to `_rex/` next to the user's checkout,
installs deps with pnpm (for `orchestrate.ts` / `finalize.ts` only), and then
`bun install -g opencode-ai@<version>` to bring in the agent binary.

## The security model (read before touching auth)

**Two layers gate every invocation:**

1. **VPS allowlist** (`packages/server/src/allowlist.ts`) — checked when the
   Action calls `POST /auth/exchange_github_app_token`. The VPS validates the
   OIDC token (via `jose` + GitHub's JWKS), reads `repository` and `actor`
   claims, and rejects if they don't match `rex.config.yml > allowlist`. This
   is the **authoritative** gate. Empty list = unrestricted; any non-empty list
   activates that gate (orgs OR repos OR users).

2. **Action permission check** (`packages/action/script/orchestrate.ts`) —
   uses the workflow's `GITHUB_TOKEN` to call `getCollaboratorPermissionLevel`
   for the actor. `/review` requires `write`, `/fix` requires `admin`.

**Token scoping**: the installation token returned by the OIDC exchange is
scoped via `repositoryNames: [repo]` and clamped through `resolvePermissions()`
in `packages/shared/src/github.ts`. Two presets:

- `NO_PUSH` — `contents: read`, `issues: write`, `pull_requests: write`. For `/review`.
- `WRITE` — full. For `/fix`.

Custom JSON objects are downgrade-only (never escalate). Unknown/garbled input
fails closed to `NO_PUSH`.

**Push must use the App token, not `GITHUB_TOKEN`** — `GITHUB_TOKEN` pushes
deliberately don't trigger downstream workflows (GitHub policy), so CI never
re-runs after `/fix`. The Action's "Configure Git for App token" step
rewrites `origin` URL with the App token to fix this. The `Run OpenCode` step
then exports `USE_GITHUB_TOKEN=true` + `GITHUB_TOKEN=$REX_APP_TOKEN` so
OpenCode itself authenticates API calls with the same App token. Don't change
either step without understanding why.

**Path traversal**: not enforced in our code anymore — OpenCode's tools have
their own safeguards. If we add Node tools that take LLM-supplied paths,
re-introduce a `safeResolve()` helper before merging.

## How the prompt is assembled

`packages/action/script/orchestrate.ts > buildPrompt()` concatenates:

1. The matching system prompt from `packages/shared/src/prompts.ts`
   (`REVIEW_SYSTEM_PROMPT` or `FIX_SYSTEM_PROMPT`).
2. A PR-context guard pinning the model to the right PR — pattern from
   `ask-bonk/github/script/orchestrate.ts:455-462`. Without this guard the
   model can drift to a different PR if git state is ambiguous.
3. The free-form user prompt extracted from the invoking comment (text after
   the `/review` or `/fix` mention).

The result is written to `$GITHUB_ENV` as `REX_PROMPT` and surfaced to
OpenCode as `PROMPT`. OpenCode treats it as the user message and starts its
own loop with its own tools.

## How a review is published (the validator)

`/review` does NOT let the model post the review with a raw `gh api
.../reviews` call. The prompt tells it to write the review as JSON to a temp
file and run `packages/action/script/post_review.ts` once. That script:

- reads the JSON with `readFileCapped()` (bounded bytes — a garbled/hostile
  blob can't OOM the runner),
- drops every inline comment whose `path`+`line` isn't a real diff line (it
  reconstructs the commentable line set from `pulls.listFiles` patches),
- pins `commit_id` to the PR head SHA itself,
- on a 422 degrades to a comments-free review, then to a plain issue comment.

**Why this is not the old terminator tool.** GitHub's review endpoint is
all-or-nothing: one inline comment off the diff 422s the whole call. With the
model driving that call raw, a single bad line number → retry loop → the
`timeout 20m opencode` kills the job (exit 124, ~20–30 min hung). `post_review.ts`
is a one-shot **deterministic post-step** — no agent loop, no Zod terminator
inside the model. The "don't reintroduce a Vercel AI SDK loop" rule below still
holds; this is a publish helper the prompt points at, not an agent.

## How triage is published (the other validator)

`/triage` is issues-only and read-only. `orchestrate.ts` resolves the target from
`ISSUE_NUMBER` (not `PR_NUMBER`), rejects a `/triage` typed on a PR (`issues.get`
returns `pull_request` for PRs), and scopes the token to `NO_PUSH`
(`contents: read`, `issues: write`). The model investigates by reading code only —
no execution, no MCP — then writes a verdict JSON and runs `post_triage.ts` once,
exactly like `/review` uses `post_review.ts`. That script posts the report comment
and applies **one** `triage/*` label via `applyTriageLabel()`
(`packages/shared/src/triage.ts`), creating the label if missing and stripping the
other three so the issue lands in a single clean state.

The four states are mutually exclusive: `triage/verified` (bug reproduced **and** a
simple fix is included), `triage/reproduced` (bug confirmed, fix needs work),
`triage/skipped` (model declined / inconclusive) — all three decided by the model —
and `triage/failed`, which **only** `finalize.ts` sets when OpenCode crashed or hit
the retry cap (the model can't report its own crash). `finalize.ts` keys off
`REX_COMMAND` + `REX_TARGET_NUMBER`, so the failure path labels the issue too.

## Input hardening (`packages/shared/src/sanitize.ts`)

Everything attacker-influenceable (anyone who can comment on a PR) is capped +
sanitized before we act on it or log it — ported from ask-bonk:

- The free-form text after `/review` is run through `sanitizeUserPrompt()`
  (strip control chars, cap bytes) and fenced as `<user_request NONCE>` data in
  the prompt so it can't override the system prompt (prompt-injection guard).
  The fence delimiter carries a random per-run nonce — a static `<user_request>`
  tag is escapable (the commenter types the literal closing tag), the nonce is
  not. Same trick `setEnv()` uses for the `$GITHUB_ENV` heredoc.
- All logged errors go through `safeErr()` (redact the App/OIDC token, strip
  control chars, truncate). Never log a raw `err.message` that touched a token.
- The review JSON the model emits is read with `readFileCapped()` and every
  field is truncated to a `MAX_*` budget before posting.

## Hung inference / provider stalls (exit 124)

A provider (seen with deepseek) can intermittently **stall mid-stream** — the
inference HTTP request stops emitting chunks with no error. OpenCode has no
per-request timeout by default, so it waits forever and the whole job hangs
until `timeout 20m opencode` kills it (**exit 124**, ~20 min of runner burned).
This looks identical in the logs to the old 422-loop: the last line is always
`llm runtime selected` right before the hang. They are different failures — the
422-loop is fixed by `post_review.ts`; the stall is bounded here.

The "Run OpenCode" step injects per-provider timeouts via
`OPENCODE_CONFIG_CONTENT` (higher precedence than repo config, so it always
wins): `provider.<provider>.options.chunkTimeout` aborts a stream that stops
emitting chunks (the real fix for a mid-stream stall) and `.options.timeout`
bounds a request that never starts. `<provider>` is derived from `MODEL` (the
part before `/`). Tunable via the `inference_chunk_timeout_ms` /
`inference_timeout_ms` action inputs. This converts an indefinite 20-min hang
into a bounded abort (~90s). It does NOT remove the outer `timeout 20m`, which
stays as the last-resort backstop. See https://opencode.ai/docs/config.

## Conventions

- **TypeScript ESM**: `"type": "module"`, `.js` import suffix in source.
  `moduleResolution: "bundler"` in `tsconfig.base.json`.
- **No `better-result` / `neverthrow` / etc.** — plain `throw`/`try`/`catch`.
  ask-bonk uses `better-result`; we deliberately don't.
- **No structured logger.** Everything is `console.log(JSON.stringify({event: "name", ...}))`.
  The `event` field is the discriminator. Easy to grep, easy to ship to Loki.
- **No comments unless the WHY is non-obvious.** Specifically: explain
  non-obvious invariants (App-token-vs-`GITHUB_TOKEN` pushes, the
  `Record<string, unknown>` intersection in `@octokit/auth-app` v8, etc.).
  Don't restate what the code does.
- **Zod for boundaries.** Server config, OIDC body, allowlist. Internal types
  are plain TS.
- **JSON-only HTTP error responses.** `{ error: "...", reason: "..." }` shape.

## How to add things

### Add a new LLM provider

OpenCode supports providers natively. To add one:

1. Document the API key env var in `DEPLOY.md > 4.3 Provider secrets`.
2. Check OpenCode's docs for the model string format (e.g. `mistral/...`).
3. Make sure the workflow exposes the provider key in `env:` so OpenCode
   picks it up.

We do not maintain a provider registry in our code anymore — that lives in
OpenCode.

### Add a new slash command (e.g. `/explain`)

1. Add to `COMMANDS` in `packages/shared/src/types.ts`.
2. Decide its permission defaults in `packages/action/script/orchestrate.ts > defaultsFor()`.
3. Add a system prompt constant in `packages/shared/src/prompts.ts` (export
   it and consume it from `systemPromptFor()` in `orchestrate.ts`).
4. Update `mentions` default in `packages/action/action.yml` if you want it
   active by default.

There's no CLI branch to edit — the system prompt and OpenCode's tools do
the work.

### Steer OpenCode differently

If review/fix behaviour needs tweaking, the only lever you have is the
system prompts in `packages/shared/src/prompts.ts`. Edit them, redeploy the
rex ref the workflow pins (`rex_ref:` input). OpenCode's behaviour can also
be configured via a `.opencode/opencode.jsonc` checked into the rex repo —
ask-bonk uses this for MCP servers.

### Change the allowlist semantics

`packages/server/src/allowlist.ts > checkAllowlist()`. The function is called
from **both** webhook ingestion (logging) and OIDC exchange (the actual gate).
Whatever you change applies to both paths.

## Commands

```bash
# Setup
pnpm install              # .npmrc disables auto-install-peers.

# Validate
pnpm typecheck            # runs tsc --noEmit in each package
pnpm -r typecheck         # same, recursive

# Run server locally (needs rex.config.yml + REX_WEBHOOK_SECRET)
pnpm dev:server           # tsx watch
```

There are no tests yet — Phase 4.

## Don't / avoid

- **Don't `--no-verify` git commits** or skip hooks unless explicitly asked.
- **Don't auto-install peer deps** — `.npmrc` has `auto-install-peers=false`.
- **Don't add a result library / structured logger / DI framework.** This
  project intentionally stays close to vanilla TS + Hono + Octokit.
- **Don't change push auth** from the App token. `GITHUB_TOKEN` pushes won't
  trigger downstream workflows.
- **Don't reintroduce a Vercel AI SDK loop** to "regain" the Zod terminator.
  If the prompts aren't enough, fix the prompts first.
- **Don't add `CODEOWNERS` parsing inline.** It's a planned Phase 4 feature —
  port from `ask-bonk/github/script/orchestrate.ts:135-187`.
- **Don't use Node.js to run the orchestrator differently.** It runs through
  `pnpm exec tsx` in the Action — keep that single entry point.

## Non-obvious type issues to remember

- `@octokit/auth-app@8` has a `StrategyOptions` type that's an intersection of
  a union plus `Record<string, unknown>`. TS can't narrow it from
  `{ appId, privateKey }` alone. Pass options through `appAuthOpts()` in
  `packages/shared/src/github.ts`, which casts.

## Roadmap

Phase 1 ✅: `/review` end-to-end (via OpenCode).
Phase 2 ✅: `/fix` (apply + commit + push to PR branch, also via OpenCode).
Phase 3 ✅: Multi-provider via OpenCode's native support (Anthropic, OpenAI,
DeepSeek, Google, etc.).
Phase 4: CODEOWNERS check, edit-in-place "rex working…" comment, `/stats`
endpoint, vitest tests, and a project-level `.opencode/opencode.jsonc` for
shared MCP/tool configuration.

When working on Phase N, update `plan.md > Roadmap por fases` and
`DEPLOY.md > 8. Phase status`.
