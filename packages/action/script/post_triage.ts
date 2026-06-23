// Deterministic triage publisher. The model (OpenCode) writes its verdict as JSON
// to a temp file and invokes this script once; we validate, post the report
// comment, and apply the matching triage/* label (creating it if the repo never
// used rex triage before, and stripping the other triage states).
//
// Why this exists — same reasoning as post_review.ts: letting the model drive the
// label/comment calls raw is fragile. The label may not exist (the call 404s), the
// model may forget to remove a stale state, or a flaky `gh` call leaves the issue
// half-labelled. This one-shot post-step makes the issue land in exactly one clean
// triage state, deterministically. It is NOT an agent loop or a terminator tool.

import { Octokit } from "@octokit/rest";
import {
  readFileCapped,
  truncateChars,
  stripControlChars,
  safeErr,
  isTriageStatus,
  applyTriageLabel,
  TRIAGE_LABELS,
  type TriageStatus,
  MAX_REVIEW_FILE_BYTES,
  MAX_COMMENT_BODY_CHARS,
} from "@rex/shared";

const DEFAULT_TRIAGE_FILE = "/tmp/rex-triage.json";

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...extra }));
}

let TOKEN = "";
function secretsForLog(): Array<string | undefined> {
  return [TOKEN, process.env.GITHUB_TOKEN, process.env.REX_APP_TOKEN];
}

function fail(reason: string): never {
  console.error(JSON.stringify({ event: "post_triage_error", error: reason }));
  process.exit(1);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const STATUS_HEADING: Record<TriageStatus, string> = {
  verified: "✅ Verified — bug reproduced, fix provided",
  reproduced: "🐛 Reproduced — bug confirmed",
  skipped: "⏭️ Skipped — inconclusive",
  failed: "💥 Failed",
};

function section(field: unknown): string {
  return truncateChars(stripControlChars(String(field ?? "")).trim(), MAX_COMMENT_BODY_CHARS);
}

function buildBody(status: TriageStatus, review: Record<string, unknown>): string {
  const parts = [`### Rex triage: ${STATUS_HEADING[status]}`, ""];
  const summary = section(review.summary);
  if (summary) parts.push(summary, "");
  const rootCause = section(review.root_cause);
  if (rootCause) parts.push("**Root cause**", "", rootCause, "");
  if (status === "verified") {
    const fix = section(review.fix);
    if (fix) parts.push("**Suggested fix**", "", fix, "");
  }
  const confidence = section(review.confidence);
  parts.push(
    "",
    `_rex triage · status: \`${TRIAGE_LABELS[status].name}\`${confidence ? ` · confidence: ${confidence}` : ""}_`,
  );
  return parts.join("\n");
}

async function run(): Promise<void> {
  TOKEN = process.env.GITHUB_TOKEN || process.env.REX_APP_TOKEN || "";
  const repoSlug = process.env.GITHUB_REPOSITORY || process.env.REX_REPOSITORY || "";
  const issueRaw =
    process.env.ISSUE_NUMBER ||
    process.env.REX_ISSUE_NUMBER ||
    process.env.REX_TARGET_NUMBER ||
    "";
  const triageFile = process.argv[2] || process.env.REX_TRIAGE_FILE || DEFAULT_TRIAGE_FILE;

  if (!TOKEN) fail("missing GITHUB_TOKEN / REX_APP_TOKEN");
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) fail(`invalid repository slug: ${repoSlug || "(empty)"}`);
  const issue_number = Number(issueRaw);
  if (!Number.isInteger(issue_number) || issue_number <= 0) {
    fail(`invalid issue number: ${issueRaw || "(empty)"}`);
  }

  let read;
  try {
    read = readFileCapped(triageFile, MAX_REVIEW_FILE_BYTES);
  } catch (err) {
    fail(`cannot read triage file ${triageFile}: ${safeErr(err)}`);
  }
  if (read.truncated) fail(`triage file ${triageFile} exceeds ${MAX_REVIEW_FILE_BYTES} bytes`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (err) {
    fail(`triage file is not valid JSON: ${safeErr(err)}`);
  }
  const review = asRecord(parsed);
  if (!review) fail("triage JSON must be an object");

  const status = review.status;
  // The model only ever decides verified/reproduced/skipped; `failed` is the
  // harness's to set (finalize.ts), never accepted from the model's JSON.
  if (!isTriageStatus(status) || status === "failed") {
    fail(`triage status must be one of verified|reproduced|skipped, got: ${String(status)}`);
  }

  const octokit = new Octokit({ auth: TOKEN });
  const body = buildBody(status, review);

  await octokit.issues.createComment({ owner, repo, issue_number, body });
  await applyTriageLabel(octokit, owner, repo, issue_number, status);

  log("post_triage_ok", { issue: issue_number, status });
}

run().catch((err) => fail(safeErr(err, secretsForLog())));
