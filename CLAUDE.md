# CLAUDE.md

Context for AI assistants working on rex. Read this before making changes.

## What rex is

Self-hosted PR review agent that mimics [ask-bonk](https://github.com/ask-bonk/ask-bonk)
(Cloudflare's CF-Workers-only bot) but runs on any VPS. Two commands:

- `/review` — leaves a polished PR review with inline comments + GitHub-suggestion blocks.
- `/fix` — applies fixes by writing files, committing, and pushing to the PR branch.

Design references in this repo: `plan.md` (full design), `DEPLOY.md` (deployment guide),
`README.md` (user-facing intro). Sibling repos `../ask-bonk/` and `../pr-agent/` are
checked out as reference material — read them when porting patterns.

## Mental model: the three components

This is the most important thing to understand. The system is intentionally
split across three runtime environments:

```
[YOUR VPS]                   [GITHUB]                  [TARGET REPO'S GH ACTIONS]
┌────────────────┐  webhook  ┌────────┐  workflow run  ┌─────────────────────┐
│ @rex/server    │◀──────────│ GitHub │───────────────▶│ @rex/action runs    │
│ (Hono)         │           │  App   │                │  ├─ orchestrate.ts  │
│                │  OIDC     │        │                │  ├─ @rex/cli (loop) │
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
   user's GitHub-hosted runner. It does the work:
   - Parses the slash command from the comment.
   - Validates the commenter's permission via `getCollaboratorPermissionLevel`.
   - Requests an installation token from the VPS server (OIDC exchange).
   - Rewrites git's stored credentials so pushes use the App token (not
     `GITHUB_TOKEN`) — see "Push must use App token" below.
   - Runs `@rex/cli`.
   - Posts a failure comment on `always()` if the CLI exited non-zero.

3. **`@rex/cli` is the agent** — runs inside the Action, has access to the
   PR's checkout via `REX_REPO_DIR=$GITHUB_WORKSPACE`. Uses Vercel AI SDK
   (`ai`) with tools (`read_file`, `grep`, `view_diff`, `submit_review`,
   etc.) to analyze the PR, then posts a review (or applies a fix and pushes).

**Why this split?** The VPS never sees the code. The agent has full filesystem
access (because it's inside `actions/checkout`) and we don't pay for VPS
compute per PR. The VPS is just a thin gate that controls who can use rex.

## Repo layout

```
packages/
├── shared/     Zod schemas, prompts, GitHub helpers (auth-app, webhook verify, token scoping)
├── server/     Hono app + config loader + allowlist + OIDC validation
├── action/     action.yml + orchestrate.ts (preflight) + finalize.ts
└── cli/        agent loop (Vercel AI SDK), tools, providers, posting, fix application
```

Each package is a pnpm workspace member with its own `package.json`. They all
share `tsconfig.base.json` and use ESM (`"type": "module"`, `.js` import suffixes
in TS source because `tsx` and TS bundler resolution require them).

The CLI is consumed inside the Action via `pnpm --filter @rex/cli start`. The
action checks out the rex repo to `_rex/` next to the user's checkout, installs
deps with pnpm, and runs from there.

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
rewrites `origin` URL with the App token to fix this. Don't change that step
without understanding why.

**Path traversal**: `safeResolve()` in `cli/src/agent/tools.ts` and `cli/src/github/fix.ts`
rejects paths that resolve outside `repoDir`. Always use it for any LLM-supplied path.

## Agent loop contract

The model controls the loop until it calls a terminator tool:

- `/review` → `submit_review({ summary, findings: Finding[] })`. Defined in `shared/types.ts`.
- `/fix` → `submit_fix({ summary, changes: FileEdit[] })`.

Both are zod-validated and capture the result into a closure (`result.current`).
The loop has `maxSteps: 30`. If the model never calls the terminator, the CLI
errors out — **the model's free text is never posted to GitHub**. Output schema
is the only contract.

For `/fix`, edits are validated by `applyEdit()` in `cli/src/github/fix.ts`:
- Empty `oldStr` + missing file → create (with `mkdir -p`).
- `oldStr` appearing 0 times → skipped with reason.
- `oldStr` appearing >1 times → skipped with reason (forces disambiguation).
- PR from a fork → entire `/fix` aborts; rex cannot push to forks.

## Conventions

- **TypeScript ESM**: `"type": "module"`, `.js` import suffix in source.
  `moduleResolution: "bundler"` in `tsconfig.base.json`.
- **No `better-result` / `neverthrow` / etc.** — plain `throw`/`try`/`catch`.
  ask-bonk uses `better-result`; we deliberately don't.
- **No structured logger.** Everything is `console.log(JSON.stringify({event: "name", ...}))`.
  The `event` field is the discriminator. Easy to grep, easy to ship to Loki.
- **No comments unless the WHY is non-obvious.** Specifically: explain non-obvious
  invariants (the App-token-vs-GITHUB_TOKEN-pushes thing, the `Record<string, unknown>`
  intersection in @octokit/auth-app v8, etc.). Don't restate what the code does.
- **Zod for boundaries.** Server config, OIDC body, tool inputs, agent submissions.
  Internal types are plain TS.
- **JSON-only HTTP error responses.** `{ error: "...", reason: "..." }` shape.
- **Path traversal protection is mandatory** for any LLM-supplied path.

## How to add things

### Add a new LLM provider

1. Install `@ai-sdk/<provider>` in `packages/cli/package.json`.
2. Add a case in `cli/src/agent/providers.ts > resolveModel(spec)`.
3. For OpenAI-compatible providers (Moonshot/Kimi, DeepSeek's older OpenAI-compat
   endpoint), use `createOpenAI({ baseURL })` from `@ai-sdk/openai` rather than
   adding a whole new SDK package.
4. Document the API key env var in `DEPLOY.md > 4.3 Provider secrets`.

### Add a new agent tool

1. Add to `cli/src/agent/tools.ts` inside `readOnlyTools()` (read-only) or
   inside `buildFixTools()` (mutating).
2. Use `tool({ description, parameters: z.object({...}), execute })`.
3. Return `{ ok: boolean, ...data }` or `{ ok: false, error: string }`. Keep
   payloads under a few KB — tool results re-enter the context window.
4. Use `safeResolve()` for any path input.
5. **Do not** add the tool's return type to a `Record<string, ReturnType<typeof tool>>` —
   that collapses the heterogeneous tool types into one. Let TS infer the shape
   of the returned object (see git history if curious).

### Add a new slash command (e.g. `/explain`)

1. Add to `COMMANDS` in `shared/src/types.ts`.
2. Decide its permission defaults in `action/script/orchestrate.ts > defaultsFor()`.
3. Add a system prompt in `shared/src/prompts.ts`.
4. In `cli/src/agent/loop.ts`, add a branch that selects the right tools +
   prompt. Define a `submit_<command>` terminator tool.
5. In `cli/src/index.ts`, add the case that interprets the submission and
   posts back to GitHub.
6. Update `mentions` default in `action/action.yml` if you want it active by default.

### Change the review formatting

`cli/src/render/summary.ts > renderReviewBody()` and `renderInlineComment()`.
The `\`\`\`suggestion` blocks are what turn into "Commit suggestion" buttons —
don't break those.

### Change the allowlist semantics

`server/src/allowlist.ts > checkAllowlist()`. The function is called from
**both** webhook ingestion (logging) and OIDC exchange (the actual gate).
Whatever you change applies to both paths.

## Commands

```bash
# Setup
pnpm install              # ~75MB. .npmrc disables auto-install-peers.

# Validate
pnpm typecheck            # runs tsc --noEmit in each package
pnpm -r typecheck         # same, recursive

# Run server locally (needs rex.config.yml + REX_WEBHOOK_SECRET)
pnpm dev:server           # tsx watch

# Run CLI locally (needs all REX_* env vars set; not easy outside an Action)
pnpm cli
```

There are no tests yet — Phase 4.

## Don't / avoid

- **Don't `--no-verify` git commits** or skip hooks unless explicitly asked.
- **Don't auto-install peer deps** — `.npmrc` has `auto-install-peers=false`.
  Adding a real dep is fine; pulling react in via `@ai-sdk/react` is a waste.
- **Don't add a result library / structured logger / DI framework.** This project
  intentionally stays close to vanilla TS + Hono + Octokit.
- **Don't post free-text from the LLM directly to GitHub.** Always go through
  `submit_review` / `submit_fix`. The schema is the safety net.
- **Don't bypass `safeResolve()`** for LLM-supplied paths. Even with a scoped
  token, the runner can write outside the repo otherwise.
- **Don't change push auth** from the App token. `GITHUB_TOKEN` pushes won't
  trigger downstream workflows.
- **Don't add `CODEOWNERS` parsing inline.** It's a planned Phase 4 feature —
  port from `ask-bonk/github/script/orchestrate.ts:135-187`.
- **Don't use `bun`.** The project standardized on pnpm 9 + Node 22 + tsx.
  ask-bonk uses Bun; we deliberately don't.

## Non-obvious type issues to remember

- `@octokit/auth-app@8` has a `StrategyOptions` type that's an intersection of
  a union plus `Record<string, unknown>`. TS can't narrow it from `{ appId, privateKey }`
  alone. Pass options through `appAuthOpts()` in `shared/src/github.ts` which casts.
- `ai` package's `Tool<T, R>` doesn't infer well through `Record<string, Tool>`.
  Don't annotate tool collections; let TS infer the heterogeneous object type.

## Roadmap

Phase 1 ✅: `/review` end-to-end.
Phase 2 ✅: `/fix` (apply + commit + push to PR branch).
Phase 3 🟡: Providers wired — Anthropic, OpenAI, DeepSeek, Google. Pending: Moonshot/Kimi.
Phase 4: CODEOWNERS check, edit-in-place "rex working…" comment, `/stats` endpoint,
         vitest tests, compile-to-JS for slimmer prod Docker image.

When working on Phase N, update `plan.md > Roadmap por fases` and `DEPLOY.md > 8. Phase status`.
