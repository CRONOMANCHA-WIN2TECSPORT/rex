# Plan: Rex — review agent self-hosted estilo ask-bonk

## Contexto

Queremos un bot de PR review (`/review` + `/fix`) con:
- **La calidad de ask-bonk** — análisis agéntico con tool-use (lee ficheros, hace grep en el repo entero, comentarios inline, suggestions clicables).
- **El modelo self-hosted de pr-agent** — corre en nuestro VPS, sin lock-in con Cloudflare.
- **Multi-proveedor** — DeepSeek, OpenAI, Claude, Gemini, Kimi.
- **Allowlist propio** — qué repos pueden usarlo y qué usuarios pueden invocarlo.

Lo que pasa por dentro de ask-bonk (que el usuario no conocía): ask-bonk en sí **no analiza nada**. Es un router webhook + permisos + OIDC. El análisis lo hace [OpenCode](https://opencode.ai), un agente CLI que corre **dentro de un GitHub Action del repo target**. El repo target hace `actions/checkout`, OpenCode tiene acceso al filesystem completo, y postea reviews vía GitHub API con el token de la App. Por eso la calidad es buena: es Claude (u otro) con tool-use sobre el filesystem real, no un single-shot sobre un diff truncado como pr-agent.

**Decisión clave ya tomada:** Rex sigue el modelo de ask-bonk (agente corre en GitHub Actions del repo target, no en el VPS), config vía workflow inputs, **TypeScript**. No copiamos OpenCode — escribimos nuestro propio agent CLI controlado (mejor formato de output, multi-provider via Vercel AI SDK).

## Arquitectura

```
┌──────────────────────────┐
│  GitHub (App + Webhook)  │
└────────────┬─────────────┘
             │ issue_comment "/review" / "/fix"
             ▼
┌──────────────────────────┐    ┌────────────────────┐
│  rex-server (VPS, Hono)  │◄───┤ rex.config.yml     │
│  - verify webhook sig    │    │ (orgs/repos/users  │
│  - allowlist check       │    │  allowlist)        │
│  - OIDC token exchange   │    └────────────────────┘
│  - run tracking          │
└────────────┬─────────────┘
             │ repository_dispatch
             ▼
┌──────────────────────────────────────────────┐
│  Target repo .github/workflows/rex.yml       │
│  ┌────────────────────────────────────────┐  │
│  │ uses: rex-org/rex/action@v1            │  │
│  │  - mentions check                      │  │
│  │  - preflight (OIDC → App token)        │  │
│  │  - permission check (write/CODEOWNERS) │  │
│  │  - bunx rex-cli review (or fix)        │  │
│  │  - finalize / failure comment          │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
             │ Octokit (con App token)
             ▼
       GitHub PR (review + inline comments + suggestions)
```

## Componentes

Monorepo `rex/` con Bun workspaces. Tres paquetes + uno compartido.

### 1. `packages/server` — webhook server (VPS)
Reemplaza el Worker de ask-bonk por un servidor Node/Bun. Hono funciona en ambos, así que mantenemos el mismo framework que ask-bonk para poder portar lógica directamente.

Endpoints:
- `POST /webhooks` — recibe eventos de GitHub App, verifica firma HMAC, chequea allowlist, dispara `repository_dispatch` al repo target con un payload mínimo (event, comment_id, actor, command).
- `POST /auth/exchange_github_app_token` — endpoint OIDC: el Action presenta su id-token, el servidor lo valida con `jose`, comprueba que el repo está en el allowlist, y devuelve un installation token con el scope solicitado (`NO_PUSH` para `/review`, `WRITE` para `/fix`).
- `GET /stats` — métricas básicas (opcional).

Estado: SQLite local (better-sqlite3) o un fichero JSON, suficiente para tracking de runs sin Redis.

### 2. `packages/action` — Composite GitHub Action
Un único `action.yml` que vive en el repo `rex` (publicable como `rex-org/rex/action@v1`). Estructura calcada a `ask-bonk/github/action.yml`:

- **Step 1 (mentions check):** bash que parsea `comment.body` contra el input `mentions` (default `/review,/fix`).
- **Step 2 (setup):** `oven-sh/setup-bun@v2`.
- **Step 3 (preflight):** corre `script/orchestrate.ts` — extrae el comando (`/review` vs `/fix`), valida permisos (`write` / `admin` / `CODEOWNERS`), intercambia el OIDC token con `rex-server` para obtener el installation token de la App, escribe `GH_TOKEN` a `$GITHUB_ENV`.
- **Step 4 (configure git):** misma lógica que ask-bonk action.yml:171-187 — reemplaza el credential del `actions/checkout` con el App token para que los pushes disparen workflows downstream.
- **Step 5 (run rex-cli):** `bunx @rex-org/cli@latest run --command=$COMMAND` (review o fix). Timeout 45m.
- **Step 6 (finalize):** si el cli falló, postea un comment "Rex run failed" con link al run.

Inputs (calcados de ask-bonk con renombrados):
- `model` — required, ej. `anthropic/claude-sonnet-4-5`, `openai/gpt-5`, `deepseek/deepseek-chat`, `google/gemini-2-5-pro`, `moonshot/kimi-k2`.
- `mentions` — default `/review,/fix`.
- `permissions` — `admin` | `write` | `any` | `CODEOWNERS`. Default `write`.
- `token_permissions` — `NO_PUSH` | `WRITE` | JSON. `/review` debería forzar `NO_PUSH` por defecto; `/fix` necesita `WRITE`.
- `rex_server_url` — URL del VPS para OIDC exchange.
- `cli_version` — pin del cli (default `latest`).
- `allowed_users` — opcional, lista YAML de logins (extra al check del VPS).
- `prompt_overrides` — opcional, prompts custom por comando.

### 3. `packages/cli` — Agent CLI (`rex-cli`)
Es el corazón del análisis. Lee la PR, corre un loop agéntico con tool-use, y postea el review.

**Stack del agent loop:**
- `ai` (Vercel AI SDK) — ya está en deps de ask-bonk, abstrae multi-provider.
  - `@ai-sdk/openai` — OpenAI, y reusable para Kimi (OpenAI-compatible endpoint de Moonshot via `baseURL`).
  - `@ai-sdk/anthropic` — Claude.
  - `@ai-sdk/google` — Gemini.
  - `@ai-sdk/deepseek` — DeepSeek.
- API keys vienen de `secrets.*` del repo target, expuestos como env vars (igual que ask-bonk: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).

**Tools que exponemos al modelo (idénticos a un Claude Code mini):**
- `read_file(path)` — lee desde el checkout local.
- `list_dir(path)` — listado del filesystem.
- `grep(pattern, glob?)` — búsqueda en el repo (ripgrep si disponible, si no `glob`).
- `view_diff()` — diff completo de la PR (vía Octokit).
- `view_pr_metadata()` — título, descripción, labels, commits.
- `view_file_at_base(path)` — versión pre-PR del fichero (vía API).
- Solo para `/fix`: `edit_file(path, oldStr, newStr)`, `create_file(path, content)`, `delete_file(path)`.

**Loop:**
```ts
while (!done && steps < MAX_STEPS) {
  const result = await generateText({
    model: providerFromString(opts.model),
    system: systemPromptFor(opts.command),
    messages,
    tools,
    stopWhen: ({ toolCalls }) => toolCalls.some(c => c.name === 'submit_review')
  });
  // ...
}
```

El loop termina cuando el modelo llama a una tool especial `submit_review({ summary, findings: Finding[] })`. Eso fuerza output estructurado sin parsing frágil de markdown.

**Schema `Finding`** (JSON estricto vía Zod):
```ts
{
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nit',
  category: 'bug' | 'security' | 'perf' | 'style' | 'design' | 'docs' | 'tests',
  path: string,
  line: number,       // línea en el HEAD del PR
  endLine?: number,
  message: string,    // markdown, 1-3 frases
  suggestion?: string // bloque de código si aplica (se renderiza como GitHub suggestion)
}
```

**Posting (estilo ask-bonk, mejor):**
- Un **review** (`POST /repos/{owner}/{repo}/pulls/{pr}/reviews`) con `event: 'COMMENT'`:
  - `body`: resumen ejecutivo con badges (`![critical](badge-url)`) + `<details>` plegables por categoría.
  - `comments[]`: cada finding como inline comment con `path` + `line` + `body`.
  - Las `suggestion` se renderizan como triple-backtick `suggestion` blocks que GitHub convierte en botón "Commit suggestion".
- Para `/fix`: además del review, hace commits a la rama del PR con los `edit_file` aplicados. Push usando el App token (clave: no `GITHUB_TOKEN` original, porque ese no dispara workflows downstream — ver ask-bonk action.yml:178-181).

### 4. `packages/shared` — tipos, prompts, GitHub helpers
- `prompts/review.md`, `prompts/fix.md` — system prompts versionados.
- `github/` — helpers reutilizables (verifyWebhook, createOctokit con `auth-app`, tokenScoping). Copia adaptada de `ask-bonk/src/github.ts`.
- `types.ts` — Zod schemas de Finding, Config, AllowlistEntry.

## Estructura de carpetas

```
rex/
├── packages/
│   ├── server/                 # VPS webhook + OIDC
│   │   ├── src/
│   │   │   ├── index.ts        # Hono app
│   │   │   ├── webhook.ts      # /webhooks handler
│   │   │   ├── oidc.ts         # /auth/exchange_github_app_token
│   │   │   ├── allowlist.ts    # loads rex.config.yml
│   │   │   └── dispatch.ts     # repository_dispatch trigger
│   │   ├── rex.config.example.yml
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── action/                 # GitHub Action composite
│   │   ├── action.yml
│   │   └── script/
│   │       ├── orchestrate.ts  # preflight: cmd parse + permissions + OIDC exchange
│   │       └── finalize.ts     # failure comment poster
│   ├── cli/                    # rex-cli (corre en el Action)
│   │   ├── src/
│   │   │   ├── index.ts        # CLI entrypoint (commander)
│   │   │   ├── agent/
│   │   │   │   ├── loop.ts     # generateText loop
│   │   │   │   ├── tools.ts    # read_file, grep, edit_file, submit_review
│   │   │   │   └── providers.ts # model string → AI SDK provider
│   │   │   ├── github/
│   │   │   │   ├── posting.ts  # createReview + inline comments
│   │   │   │   ├── pr.ts       # PR metadata + diff fetchers
│   │   │   │   └── fix.ts      # apply edits + commit + push
│   │   │   └── render/
│   │   │       └── summary.ts  # markdown render of findings
│   │   └── package.json
│   └── shared/
│       ├── src/
│       │   ├── types.ts        # Zod: Finding, Config
│       │   ├── prompts/
│       │   │   ├── review.md
│       │   │   └── fix.md
│       │   └── github.ts       # webhooks, auth-app, token scoping
│       └── package.json
├── package.json                # bun workspaces
├── tsconfig.base.json
└── README.md
```

## Flujo end-to-end: `/review`

1. Usuario escribe `/review` en un PR.
2. GitHub manda webhook `issue_comment` a `https://rex.miservidor.com/webhooks`.
3. `server/webhook.ts`:
   - Verifica firma HMAC (reusa patrón de `ask-bonk/src/github.ts:101-143`).
   - Carga `rex.config.yml`: ¿el repo está en `allowed_repos`? ¿el sender en `allowed_users`?
   - Si OK, dispara `repository_dispatch` con `event_type: rex-review` y client_payload `{ comment_id, actor, command, pr_number }`.
4. Workflow `rex.yml` en el repo target reacciona al dispatch (o el propio `issue_comment`, según preferencia — se puede saltar el VPS para el dispatch y hacerlo más directo, pero el VPS sigue siendo necesario para OIDC).
5. Action steps:
   - mentions check → encuentra `/review`.
   - `script/orchestrate.ts` valida permiso del actor (`write` por default) — si falla, sale silenciosamente con un comment "no permission".
   - OIDC exchange con `https://rex.miservidor.com/auth/exchange_github_app_token` → recibe installation token con `contents: read, pull_requests: write, issues: write` (NO_PUSH para /review).
   - `actions/checkout@v4` ya hizo el checkout del head SHA.
   - `bunx @rex-org/cli run --command=review --model=$MODEL`.
6. `rex-cli`:
   - Lee diff + PR metadata vía Octokit.
   - Construye system prompt (`prompts/review.md`) con: convenciones del repo (lee `AGENTS.md`/`CLAUDE.md` si existen), reglas de severidad, formato esperado.
   - Loop agéntico hasta que el modelo llame `submit_review`.
   - Postea: 1 review con summary body + N inline comments con suggestions.
7. `finalize.ts` corre `always()`: si el cli salió ≠ 0, postea comment de fallo con link al run.

## Flujo `/fix`

Idéntico a `/review` excepto:
- En `orchestrate.ts`, el permission gate es `admin` o `CODEOWNERS` (más estricto).
- Token scope solicitado al OIDC: `WRITE` (puede pushear).
- `rex-cli` arranca con tools de edición habilitadas (`edit_file`, `create_file`, `delete_file`).
- En vez de `submit_review` el modelo llama `submit_fix({ summary, changes: Edit[] })`.
- `github/fix.ts` aplica los edits al working tree, `git add -A`, `git commit -m "[rex] $summary"`, `git push` (al branch del PR, autenticado con el App token — esto sí dispara CI, ver ask-bonk action.yml:178-181).
- Postea un comment resumiendo qué cambió + link al commit.

## Configuración

### En el repo target — `.github/workflows/rex.yml`
Único archivo que el usuario añade. Ejemplo:

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
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: rex-org/rex/action@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # DEEPSEEK_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, MOONSHOT_API_KEY...
        with:
          model: anthropic/claude-sonnet-4-5
          mentions: "/review,/fix"
          permissions: write          # /review
          # token_permissions: NO_PUSH (se infiere por comando)
          rex_server_url: https://rex.miservidor.com
          allowed_users: "fjimenez,otro-user"  # opcional, además del VPS allowlist
```

### En el VPS — `rex.config.yml`

```yaml
github_app:
  app_id: 12345
  private_key_path: /etc/rex/app.pem
  webhook_secret_env: REX_WEBHOOK_SECRET

allowlist:
  # Si vacío, todo el mundo. Si no vacío, solo lo listado.
  orgs:
    - fjimenez
  repos:
    - fjimenez/proyecto-x
    - org/otro-repo
  users:
    - fjimenez
    - colega1

defaults:
  max_steps: 30
  max_tokens_per_call: 8000
  timeout_minutes: 30

oidc:
  audience: rex.miservidor.com
```

## Allowlist / permisos (dos capas)

1. **VPS allowlist** (server-side, autoritario): `server/allowlist.ts` se ejecuta en cada webhook **y** en cada OIDC exchange. Rechaza eventos de repos/orgs/users no listados. Si el modelo intenta hacer cross-repo, el OIDC sólo emite tokens para repos listados (calcamos `ask-bonk/src/oidc.ts` `handleExchangeTokenForRepo` que valida same-org + write-access).
2. **Action permissions** (per-comando): orchestrate.ts valida que el `actor` tiene el permiso requerido (`write`/`admin`/`CODEOWNERS`). CODEOWNERS parsing: portamos la lógica de `ask-bonk/github/script/orchestrate.ts:135-187`.

`/review` → permiso mínimo `write` + token `NO_PUSH`.
`/fix` → permiso mínimo `admin` o `CODEOWNERS` + token `WRITE`.

## Multi-proveedor LLM

Una sola función `providerFromString(modelString)` en `cli/src/agent/providers.ts`:

```ts
// "anthropic/claude-sonnet-4-5" → anthropic(...)
// "openai/gpt-5"               → openai(...)
// "deepseek/deepseek-chat"     → deepseek(...)
// "google/gemini-2-5-pro"      → google(...)
// "moonshot/kimi-k2"           → openaiCompat({ baseURL: 'https://api.moonshot.ai/v1' })
```

Vercel AI SDK uniformiza tool-use entre todos. Si un provider no soporta tool-use bien, fallback a JSON-mode con un único prompt + parsing de la respuesta como `submit_review`.

## Patrones concretos que reutilizamos de ask-bonk

| Qué | De ask-bonk | Adaptación rex |
|---|---|---|
| HMAC webhook verify | `src/github.ts:101-143` | Idéntico, en `server/webhook.ts` |
| Octokit App auth | `src/github.ts:22-59` | Idéntico, en `shared/github.ts` |
| OIDC validation | `src/oidc.ts:53-90` | Idéntico, valida `aud`, `repository`, `actor` |
| Token scoping (NO_PUSH/WRITE) | `src/oidc.ts` + `github/script/context.ts` | Mismas presets |
| Mentions parser bash | `github/action.yml:61-103` | Copia textual |
| CODEOWNERS check | `github/script/orchestrate.ts:135-187` | Copia textual |
| Git credential rewrite | `github/action.yml:171-187` | Copia textual (necesario para que pushes disparen CI) |
| Finalize/failure comment | `src/agent.ts:512-624` + `github/script/finalize.ts` | Simplificado: sin Durable Object, solo postea |
| Edit-in-place comment strategy | `src/agent.ts` (waiting → working → done) | Útil para UX, mismo patrón |

## Lo que NO copiamos de ask-bonk

- **Cloudflare-specific stuff**: Durable Objects (`agents`), `@cloudflare/sandbox`, Workers runtime. Sustituimos por SQLite + Node/Bun runtime.
- **OpenCode**: escribimos nuestro agent loop. Razones: control del output schema, no dependencia externa, podemos versionar los prompts.

## Roadmap por fases

**Fase 1 — MVP `/review` (semana 1-2)**
- `shared/`: tipos + prompts iniciales.
- `server/`: webhook + allowlist + OIDC + repository_dispatch. Sin tracking.
- `action/`: action.yml composite con preflight + finalize.
- `cli/`: agent loop con tools read_file/list_dir/grep/view_diff + `submit_review` + posting (createReview + inline comments).
- Solo Anthropic + OpenAI providers.
- Probar contra un repo de test.

**Fase 2 — `/fix` (semana 3)**
- Tools de edición + `submit_fix`.
- `fix.ts`: aplica edits, commit, push con App token.
- Permission gate `admin`/CODEOWNERS.

**Fase 3 — Multi-proveedor completo (semana 4)**
- DeepSeek, Gemini, Moonshot/Kimi.
- Fallback JSON-mode para providers con tool-use flaky.

**Fase 4 — Pulido**
- Render avanzado: badges, `<details>` por categoría, severity grouping.
- Edit-in-place del waiting comment (UX).
- `/stats` endpoint.
- Tests con `vitest` (calcamos config de ask-bonk).

## Verificación

Para validar end-to-end antes de cerrar cada fase:

1. **Local server smoke test**:
   - `bun run --cwd packages/server dev` → `curl -X POST localhost:3000/webhooks -H "X-Hub-Signature-256: ..." -d @fixtures/issue_comment.json` → ver que dispara dispatch (mockeado).
2. **Action en repo de pruebas**:
   - Crear `fjimenez/rex-sandbox`, instalar la GitHub App apuntando al VPS, copiar `.github/workflows/rex.yml`.
   - Abrir un PR de prueba con bugs intencionados (null deref, SQL injection, off-by-one).
   - Comentar `/review`, verificar:
     - Permission check pasa.
     - OIDC exchange devuelve token con `contents: read`.
     - rex-cli corre el loop y postea review con findings.
     - Cada finding aparece como inline comment con suggestion clicable.
3. **Allowlist negativo**: borrar el repo de `rex.config.yml`, comentar `/review`, verificar que el webhook lo rechaza sin disparar el workflow.
4. **`/fix` happy path**: PR con un typo en un string, `/fix` lo cambia, hace commit, dispara CI del repo (verifica que el App token funciona y no `GITHUB_TOKEN`).
5. **Multi-provider**: cambiar `model:` en el workflow a `deepseek/deepseek-chat`, repetir el test, verificar mismo output schema.

## Archivos a crear (resumen)

Greenfield en `/Users/fjimenez/Documents/Proyectos/Fermin/agent/rex/`:

- `package.json` (bun workspaces), `tsconfig.base.json`, `.gitignore`
- `packages/shared/` — tipos, prompts (`review.md`, `fix.md`), helpers GitHub
- `packages/server/` — Hono app: `index.ts`, `webhook.ts`, `oidc.ts`, `allowlist.ts`, `dispatch.ts`, `Dockerfile`, `rex.config.example.yml`
- `packages/action/` — `action.yml` + `script/orchestrate.ts` + `script/finalize.ts`
- `packages/cli/` — `src/index.ts`, `src/agent/{loop,tools,providers}.ts`, `src/github/{pr,posting,fix}.ts`, `src/render/summary.ts`
- `README.md` con quickstart (instalar App, copiar workflow, secrets)

Los archivos clave a estudiar para portar lógica son:
- `ask-bonk/src/github.ts` (auth, webhook verify)
- `ask-bonk/src/oidc.ts` (token exchange, scoping)
- `ask-bonk/github/action.yml` (composite action skeleton)
- `ask-bonk/github/script/orchestrate.ts` (CODEOWNERS, mentions, prompt assembly)
- `pr-agent/pr_agent/agent/pr_agent.py:24-44` (command2class — patrón de registro de comandos, aunque en rex es enum simple)
