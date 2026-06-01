// Deterministic review poster. The model (OpenCode) writes its review as JSON to
// a temp file and invokes this script once; we validate, anchor, and publish.
//
// Why this exists: posting a PR review via the GitHub API is all-or-nothing —
// a *single* inline comment whose line doesn't fall inside the diff makes the
// whole `POST /pulls/{n}/reviews` call 422. Letting the model drive that call
// raw means one bad line number fails the review, the model retries, and with
// nothing to recover it loops until the 20-minute `timeout` kills the job
// (exit 124). This script removes that failure mode deterministically:
//
//   1. Read the review JSON from a temp file, capped at MAX_REVIEW_FILE_BYTES
//      (a hostile/garbled blob can't OOM us).
//   2. Drop every inline comment that doesn't anchor to a line in the real diff.
//   3. Pin `commit_id` to the PR head SHA ourselves (the model used to copy a
//      "HEAD_SHA" placeholder → instant 422).
//   4. If the API still 422s, degrade to a comments-free review, then to a plain
//      issue comment. The author always gets feedback; the job never hangs.
//
// This is NOT a return of the old Vercel AI SDK terminator tool — there is no
// agent loop here. It's a one-shot, deterministic publish step the prompt points
// the model at instead of raw `gh api`.

import { Octokit } from "@octokit/rest";
import {
  readFileCapped,
  truncateChars,
  stripControlChars,
  safeErr,
  MAX_REVIEW_FILE_BYTES,
  MAX_REVIEW_BODY_CHARS,
  MAX_COMMENT_BODY_CHARS,
  MAX_INLINE_COMMENTS,
} from "@rex/shared";

const REVIEW_EVENTS = new Set(["COMMENT", "REQUEST_CHANGES", "APPROVE"]);
const DEFAULT_REVIEW_FILE = "/tmp/rex-review.json";

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...extra }));
}

function fail(reason: string): never {
  console.error(JSON.stringify({ event: "post_review_error", error: reason }));
  process.exit(1);
}

interface OutComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
}

// Build, per file, a map of new-file line number -> hunk id for every line that
// is part of the diff (added + context lines inside a hunk). These are the only
// lines a RIGHT-side review comment can legally anchor to. We keep the hunk id
// (not just a flat set) because a multi-line comment's start_line..line range
// must stay within a SINGLE hunk — GitHub 422s a cross-hunk range, and that
// 422 would reject the whole inline batch.
async function diffLineIndex(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<Map<string, Map<number, number>>> {
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  const index = new Map<string, Map<number, number>>();
  for (const f of files) {
    if (!f.patch) continue; // binary / too-large files have no patch
    const valid = new Map<number, number>();
    let newLine = 0;
    let hunkId = 0;
    let inHunk = false;
    for (const line of f.patch.split("\n")) {
      if (line.startsWith("@@")) {
        const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        if (m) newLine = parseInt(m[1], 10);
        hunkId++;
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      const c = line[0];
      if (c === "+") {
        valid.set(newLine, hunkId);
        newLine++;
      } else if (c === "-" || c === "\\") {
        // removed line (old side only) or "\ No newline at end of file" marker
      } else {
        // context line (leading space) — commentable, advances the new side
        valid.set(newLine, hunkId);
        newLine++;
      }
    }
    index.set(f.filename, valid);
  }
  return index;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function main(): Promise<void> {
  return run().catch((err) => fail(safeErr(err, secretsForLog())));
}

let TOKEN = "";
function secretsForLog(): Array<string | undefined> {
  return [TOKEN, process.env.GITHUB_TOKEN, process.env.REX_APP_TOKEN];
}

async function run(): Promise<void> {
  TOKEN = process.env.GITHUB_TOKEN || process.env.REX_APP_TOKEN || "";
  const repoSlug = process.env.GITHUB_REPOSITORY || process.env.REX_REPOSITORY || "";
  const prRaw =
    process.env.PR_NUMBER || process.env.REX_PR_NUMBER || process.env.ISSUE_NUMBER || "";
  const reviewFile = process.argv[2] || process.env.REX_REVIEW_FILE || DEFAULT_REVIEW_FILE;

  if (!TOKEN) fail("missing GITHUB_TOKEN / REX_APP_TOKEN");
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) fail(`invalid repository slug: ${repoSlug || "(empty)"}`);
  const pull_number = Number(prRaw);
  if (!Number.isInteger(pull_number) || pull_number <= 0) fail(`invalid PR number: ${prRaw || "(empty)"}`);

  let read;
  try {
    read = readFileCapped(reviewFile, MAX_REVIEW_FILE_BYTES);
  } catch (err) {
    fail(`cannot read review file ${reviewFile}: ${safeErr(err)}`);
  }
  if (read.truncated) {
    // Parsing a truncated JSON object will fail anyway; surface the real cause.
    fail(`review file ${reviewFile} exceeds ${MAX_REVIEW_FILE_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (err) {
    fail(`review file is not valid JSON: ${safeErr(err)}`);
  }
  const review = asRecord(parsed);
  if (!review) fail("review JSON must be an object");

  const octokit = new Octokit({ auth: TOKEN });

  // Pin commit_id to the real head SHA — never trust a model-supplied value.
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
  const commit_id = pr.head.sha;

  const body = truncateChars(stripControlChars(String(review.body ?? "")), MAX_REVIEW_BODY_CHARS);
  const event = REVIEW_EVENTS.has(String(review.event)) ? String(review.event) : "COMMENT";

  const rawComments = Array.isArray(review.comments) ? review.comments : [];
  const validIndex = await diffLineIndex(octokit, owner, repo, pull_number);

  const kept: OutComment[] = [];
  let dropped = 0;
  for (const rc of rawComments) {
    if (kept.length >= MAX_INLINE_COMMENTS) {
      dropped += rawComments.length - rawComments.indexOf(rc);
      break;
    }
    const c = asRecord(rc);
    const path = c?.path;
    const line = c?.line;
    if (typeof path !== "string" || typeof line !== "number" || !Number.isInteger(line)) {
      dropped++;
      continue;
    }
    const valid = validIndex.get(path);
    if (!valid || !valid.has(line)) {
      dropped++;
      continue;
    }
    const out: OutComment = {
      path,
      line,
      side: "RIGHT",
      body: truncateChars(stripControlChars(String(c?.body ?? "")), MAX_COMMENT_BODY_CHARS),
    };
    // Only attach a multi-line range when both ends sit in the SAME hunk —
    // otherwise GitHub 422s the range. If they don't, demote to a single-line
    // comment anchored at `line` (still posts) rather than dropping it.
    const startLine = c?.start_line;
    if (
      typeof startLine === "number" &&
      startLine < line &&
      valid.get(startLine) === valid.get(line)
    ) {
      out.start_line = startLine;
      out.start_side = "RIGHT";
    }
    kept.push(out);
  }

  // body is required for COMMENT/REQUEST_CHANGES; APPROVE may be empty.
  const safeBody = body || (event === "APPROVE" ? "" : "Rex review.");

  try {
    const res = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      commit_id,
      event: event as "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
      body: safeBody,
      comments: kept,
    });
    log("post_review_ok", { review_id: res.data.id, posted_comments: kept.length, dropped });
    return;
  } catch (err) {
    const status = (err as { status?: number }).status;
    log("post_review_inline_failed", {
      status,
      attempted_comments: kept.length,
      dropped,
      error: safeErr(err, secretsForLog()),
    });
    if (!(status === 422 && kept.length > 0)) {
      fail(safeErr(err, secretsForLog()));
    }
  }

  // Fallback A: same review, no inline comments. An inline anchor GitHub
  // rejected can't nuke a comments-free review.
  const fallbackBody = [
    safeBody,
    "",
    "_(rex: inline comments were omitted — they didn't anchor to the PR diff.)_",
  ].join("\n");
  try {
    const res = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      commit_id,
      event: event as "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
      body: fallbackBody,
      comments: [],
    });
    log("post_review_fallback_ok", { review_id: res.data.id });
    return;
  } catch (err) {
    log("post_review_fallback_failed", { error: safeErr(err, secretsForLog()) });
  }

  // Fallback B: a plain issue comment never 422s on line anchoring.
  await octokit.issues.createComment({ owner, repo, issue_number: pull_number, body: fallbackBody });
  log("post_review_fallback_comment_ok", {});
}

main();
