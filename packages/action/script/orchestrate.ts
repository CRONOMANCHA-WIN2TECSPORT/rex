import * as core from "@actions/core";
import { appendFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { COMMANDS, type Command, REVIEW_SYSTEM_PROMPT, FIX_SYSTEM_PROMPT } from "@rex/shared";

interface Env {
  EVENT_NAME: string;
  COMMENT_BODY?: string;
  REVIEW_BODY?: string;
  MENTIONS: string;
  REQUIRED_PERMISSION: string;
  TOKEN_PERMISSIONS_INPUT: string;
  ALLOWED_USERS: string;
  REX_SERVER_URL: string;
  OIDC_AUDIENCE: string;
  FORKS: string;
  ACTION_TOKEN: string;
  ACTOR: string;
  REPOSITORY: string;
  PR_NUMBER?: string;
  IS_FORK?: string;
}

function env(): Env {
  return process.env as unknown as Env;
}

function commentBody(e: Env): string {
  switch (e.EVENT_NAME) {
    case "issue_comment":
    case "pull_request_review_comment":
      return e.COMMENT_BODY ?? "";
    case "pull_request_review":
      return e.REVIEW_BODY ?? "";
    default:
      return "";
  }
}

function parseCommand(body: string, mentions: string): { command: Command; prompt: string } | null {
  // Find the first mention; everything that follows (on the same line or after)
  // becomes the free-form prompt for the agent.
  const mentionList = mentions.split(",").map((m) => m.trim()).filter(Boolean);
  for (const m of mentionList) {
    const idx = body.indexOf(m);
    if (idx === -1) continue;
    const after = body.slice(idx + m.length).trim();
    const raw = m.replace(/^[/@]+/, "").toLowerCase();
    if ((COMMANDS as readonly string[]).includes(raw)) {
      return { command: raw as Command, prompt: after };
    }
  }
  // Fallback: literally search for "/review" or "/fix" as a standalone command.
  for (const c of COMMANDS) {
    const re = new RegExp(`(?:^|\\s)/${c}\\b(.*)`, "i");
    const match = body.match(re);
    if (match) return { command: c as Command, prompt: (match[1] ?? "").trim() };
  }
  return null;
}

function defaultsFor(command: Command): {
  permission: "admin" | "write" | "any" | "CODEOWNERS";
  tokenPermissions: "NO_PUSH" | "WRITE";
} {
  if (command === "fix") return { permission: "admin", tokenPermissions: "WRITE" };
  return { permission: "write", tokenPermissions: "NO_PUSH" };
}

async function checkPermission(
  octokit: Octokit,
  owner: string,
  repo: string,
  actor: string,
  required: "admin" | "write" | "any" | "CODEOWNERS",
): Promise<{ ok: boolean; reason?: string }> {
  if (required === "any") return { ok: true };
  if (required === "CODEOWNERS") {
    // Phase 4: not implemented — fall back to "write".
    required = "write";
  }
  try {
    const { data } = await octokit.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: actor,
    });
    if (required === "admin" && data.permission !== "admin") {
      return { ok: false, reason: `actor ${actor} is not admin (${data.permission})` };
    }
    if (required === "write" && !["admin", "write"].includes(data.permission)) {
      return { ok: false, reason: `actor ${actor} lacks write (${data.permission})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: errMsg(err) };
  }
}

async function exchangeOIDC(
  rexServerUrl: string,
  audience: string,
  tokenPermissions: string,
): Promise<{ token: string }> {
  const oidcToken = await core.getIDToken(audience);
  const url = `${rexServerUrl.replace(/\/$/, "")}/auth/exchange_github_app_token`;
  const body = tokenPermissions ? { permissions: parsePermissions(tokenPermissions) } : {};
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${oidcToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OIDC exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { token: string };
}

function parsePermissions(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === "NO_PUSH" || trimmed === "WRITE") return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return "NO_PUSH";
  }
}

function setOutput(name: string, value: string): void {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${name}=${value}\n`);
}

function setEnv(name: string, value: string): void {
  const f = process.env.GITHUB_ENV;
  if (!f) return;
  // Multiline values need a random delimiter to avoid injection from user prompts.
  const delim = `__REX_EOF_${Math.random().toString(36).slice(2, 10)}__`;
  appendFileSync(f, `${name}<<${delim}\n${value}\n${delim}\n`);
}

function maskValue(value: string): void {
  // GitHub Actions secret masking. Done for the App token only.
  if (value) console.log(`::add-mask::${value}`);
}

function skip(reason: string): void {
  console.log(JSON.stringify({ event: "preflight_skip", reason }));
  setOutput("skip", "true");
  process.exit(0);
}

function systemPromptFor(command: Command): string {
  return command === "fix" ? FIX_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT;
}

function buildPrompt(command: Command, repo: string, prNumber: string, userPrompt: string): string {
  // The PR context guard pins OpenCode to the correct PR even if git state or
  // tool calls are ambiguous. Pattern from ask-bonk: see
  // ask-bonk/github/script/orchestrate.ts:455-462.
  const parts: string[] = [systemPromptFor(command)];
  if (prNumber) {
    parts.push(
      `You are working on PR #${prNumber} in ${repo}. When posting reviews or comments, always target PR #${prNumber}.`,
    );
  }
  if (userPrompt.trim()) parts.push(userPrompt.trim());
  return parts.join("\n\n");
}

async function main() {
  const e = env();
  const body = commentBody(e);
  const parsed = parseCommand(body, e.MENTIONS);
  if (!parsed) skip("no rex command in comment");

  const { command, prompt: userPrompt } = parsed!;

  if (e.FORKS === "true" && e.IS_FORK === "true") {
    skip("fork PRs disabled by `forks: true`");
  }

  const [owner, repo] = e.REPOSITORY.split("/");
  const octokit = new Octokit({ auth: e.ACTION_TOKEN });

  const requiredPerm =
    (e.REQUIRED_PERMISSION as "admin" | "write" | "any" | "CODEOWNERS") ||
    defaultsFor(command).permission;

  const allowedUsers = e.ALLOWED_USERS.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (allowedUsers.length > 0 && !allowedUsers.includes(e.ACTOR)) {
    skip(`actor ${e.ACTOR} not in allowed_users`);
  }

  const perm = await checkPermission(octokit, owner, repo, e.ACTOR, requiredPerm);
  if (!perm.ok) skip(perm.reason ?? "permission denied");

  if (e.PR_NUMBER) {
    // Verify the PR exists and is reachable with the workflow token before we
    // burn an OIDC exchange. Avoids confusing failures later if the actor
    // commented on something we can't read.
    try {
      await octokit.pulls.get({ owner, repo, pull_number: Number(e.PR_NUMBER) });
    } catch (err) {
      skip(`failed to fetch PR ${e.PR_NUMBER}: ${errMsg(err)}`);
    }
  }

  const tokenPerm = e.TOKEN_PERMISSIONS_INPUT || defaultsFor(command).tokenPermissions;

  let appToken: string;
  try {
    const result = await exchangeOIDC(e.REX_SERVER_URL, e.OIDC_AUDIENCE, tokenPerm);
    appToken = result.token;
  } catch (err) {
    console.error(JSON.stringify({ event: "oidc_exchange_failed", error: errMsg(err) }));
    process.exit(1);
  }

  maskValue(appToken);

  const fullPrompt = buildPrompt(command, e.REPOSITORY, e.PR_NUMBER ?? "", userPrompt);

  setOutput("skip", "false");
  setEnv("REX_APP_TOKEN", appToken);
  setEnv("REX_PR_NUMBER", e.PR_NUMBER ?? "");
  setEnv("REX_PROMPT", fullPrompt);

  console.log(
    JSON.stringify({
      event: "preflight_ok",
      command,
      actor: e.ACTOR,
      repo: e.REPOSITORY,
      pr: e.PR_NUMBER,
      token_permissions: tokenPerm,
      prompt_chars: fullPrompt.length,
    }),
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "preflight_error", error: errMsg(err) }));
  process.exit(1);
});
