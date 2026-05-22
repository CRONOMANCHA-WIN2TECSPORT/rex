import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { Octokit } from "@octokit/rest";
import type { FileEdit, FixSubmission } from "@rex/shared";

export interface ApplyFixArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  repoDir: string;
  submission: FixSubmission;
}

export interface ApplyFixResult {
  pushed: boolean;
  commitSha?: string;
  branch?: string;
  appliedFiles: string[];
  skipped: { path: string; reason: string }[];
  reason?: string;
}

export async function applyFix(args: ApplyFixArgs): Promise<ApplyFixResult> {
  const { octokit, owner, repo, prNumber, repoDir, submission } = args;

  if (submission.changes.length === 0) {
    return {
      pushed: false,
      appliedFiles: [],
      skipped: [],
      reason: "submission contained zero changes",
    };
  }

  const prInfo = await fetchHeadRef(octokit, owner, repo, prNumber);
  if (prInfo.fromFork) {
    return {
      pushed: false,
      appliedFiles: [],
      skipped: [],
      reason: "PR head is on a fork; rex cannot push to forks",
    };
  }

  const applied: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const edit of submission.changes) {
    const outcome = applyEdit(repoDir, edit);
    if (outcome.ok) applied.push(edit.path);
    else skipped.push({ path: edit.path, reason: outcome.reason });
  }

  if (applied.length === 0) {
    return {
      pushed: false,
      appliedFiles: [],
      skipped,
      reason: "no edits applied (all skipped — see `skipped[]`)",
    };
  }

  ensureGitIdentity(repoDir);

  // Detached HEAD after `actions/checkout` of the SHA — attach to the PR branch.
  runGit(repoDir, ["checkout", "-B", prInfo.headRef]);
  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", commitMessage(submission)]);
  const sha = runGit(repoDir, ["rev-parse", "HEAD"]).stdout.trim();
  runGit(repoDir, ["push", "origin", `HEAD:${prInfo.headRef}`]);

  return {
    pushed: true,
    commitSha: sha,
    branch: prInfo.headRef,
    appliedFiles: applied,
    skipped,
  };
}

interface EditOutcome {
  ok: boolean;
  reason: string;
}

function applyEdit(repoDir: string, edit: FileEdit): EditOutcome {
  let abs: string;
  try {
    abs = safeResolve(repoDir, edit.path);
  } catch (err) {
    return { ok: false, reason: errMsg(err) };
  }

  // Treat "create file" as oldStr === "".
  const creating = edit.oldStr === "" && !fileExists(abs);
  if (creating) {
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, edit.newStr, "utf8");
      return { ok: true, reason: "created" };
    } catch (err) {
      return { ok: false, reason: `create failed: ${errMsg(err)}` };
    }
  }

  // Treat "delete file" as a deletion sentinel only if requested explicitly;
  // we don't honor it from the LLM unless newStr === "" and oldStr matches
  // the WHOLE file. Avoids accidental deletions.
  let original: string;
  try {
    original = readFileSync(abs, "utf8");
  } catch (err) {
    return { ok: false, reason: `read failed: ${errMsg(err)}` };
  }

  const occurrences = countOccurrences(original, edit.oldStr);
  if (occurrences === 0) {
    return { ok: false, reason: "oldStr not found in file" };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      reason: `oldStr appears ${occurrences} times — disambiguate with more context`,
    };
  }
  const next = original.replace(edit.oldStr, edit.newStr);
  try {
    writeFileSync(abs, next, "utf8");
  } catch (err) {
    return { ok: false, reason: `write failed: ${errMsg(err)}` };
  }
  return { ok: true, reason: "edited" };
}

function fileExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function safeResolve(repoDir: string, p: string): string {
  const absRoot = resolve(repoDir);
  const target = resolve(repoDir, p);
  const rel = relative(absRoot, target);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`path escapes repo: ${p}`);
  }
  return target;
}

interface HeadRef {
  headRef: string;
  headSha: string;
  fromFork: boolean;
}

async function fetchHeadRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<HeadRef> {
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const baseRepoFull = pr.base.repo.full_name;
  const headRepoFull = pr.head.repo?.full_name ?? baseRepoFull;
  return {
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    fromFork: baseRepoFull !== headRepoFull,
  };
}

function ensureGitIdentity(repoDir: string): void {
  const checkName = runGitAllowFailure(repoDir, ["config", "user.name"]);
  if (checkName.status !== 0 || !checkName.stdout.trim()) {
    runGit(repoDir, ["config", "user.name", "rex[bot]"]);
    runGit(repoDir, ["config", "user.email", "rex[bot]@users.noreply.github.com"]);
  }
}

function commitMessage(submission: FixSubmission): string {
  const summary = submission.summary.trim().split("\n").map((l) => l.trim()).join(" ");
  const title = summary.length > 70 ? summary.slice(0, 67) + "..." : summary;
  const body = submission.summary.trim();
  return `[rex] ${title}\n\n${body}`;
}

function runGit(cwd: string, args: string[]): SpawnSyncReturns<string> {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${res.status}): ${res.stderr || res.stdout}`,
    );
  }
  return res;
}

function runGitAllowFailure(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
