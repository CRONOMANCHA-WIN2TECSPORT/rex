import { tool } from "ai";
import { z } from "zod";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Octokit } from "@octokit/rest";
import {
  FileEditSchema,
  ReviewSubmissionSchema,
  FixSubmissionSchema,
  type FixSubmission,
  type ReviewSubmission,
} from "@rex/shared";

export interface ToolContext {
  repoDir: string;
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

const MAX_FILE_BYTES = 250_000;
const MAX_GREP_RESULTS = 200;
const MAX_DIR_ENTRIES = 200;

function safeResolve(repoDir: string, p: string): string {
  const absRoot = resolve(repoDir);
  const target = resolve(repoDir, p);
  const rel = relative(absRoot, target);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`path escapes repo: ${p}`);
  }
  return target;
}

export function buildReviewTools(ctx: ToolContext) {
  const result: { current: ReviewSubmission | null } = { current: null };
  return {
    result,
    tools: {
      ...readOnlyTools(ctx),
      submit_review: tool({
        description:
          "Submit the final code review. Call this exactly once when you're done analyzing. After this call, do not invoke more tools.",
        parameters: ReviewSubmissionSchema,
        execute: async (input) => {
          result.current = input;
          return {
            ok: true,
            findings: input.findings.length,
            note: "Review submitted. Stop now.",
          };
        },
      }),
    },
  };
}

export function buildFixTools(ctx: ToolContext) {
  const result: { current: FixSubmission | null } = { current: null };
  return {
    result,
    tools: {
      ...readOnlyTools(ctx),
      submit_fix: tool({
        description:
          "Submit the final set of file edits. Call this exactly once when you've identified the minimal change set. Do not modify files via execute — the host will apply your edits after this call.",
        parameters: FixSubmissionSchema,
        execute: async (input) => {
          result.current = input;
          return {
            ok: true,
            changes: input.changes.length,
            note: "Fix submitted. Stop now.",
          };
        },
      }),
      // Optional helper: provide a dry-run edit applicator that returns the new file contents
      // so the model can sanity-check, but doesn't touch disk.
      preview_edit: tool({
        description:
          "Preview what a file would look like after applying an edit. Returns the new contents (truncated). Does not write to disk.",
        parameters: FileEditSchema,
        execute: async (input) => {
          const abs = safeResolve(ctx.repoDir, input.path);
          let original: string;
          try {
            original = readFileSync(abs, "utf8");
          } catch (err) {
            return { ok: false, error: errMsg(err) };
          }
          if (!original.includes(input.oldStr)) {
            return { ok: false, error: "oldStr not found in file (exact match required)" };
          }
          const next = original.replace(input.oldStr, input.newStr);
          return { ok: true, preview: truncate(next, MAX_FILE_BYTES) };
        },
      }),
    },
  };
}

function readOnlyTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read a file from the PR's checkout. Paths are relative to the repo root. Files larger than ~250KB are truncated.",
      parameters: z.object({
        path: z.string().describe("File path relative to repo root."),
      }),
      execute: async ({ path }) => {
        try {
          const abs = safeResolve(ctx.repoDir, path);
          const content = readFileSync(abs, "utf8");
          return { ok: true, path, content: truncate(content, MAX_FILE_BYTES) };
        } catch (err) {
          return { ok: false, path, error: errMsg(err) };
        }
      },
    }),

    list_dir: tool({
      description: "List entries (files and directories) in a directory of the repo checkout.",
      parameters: z.object({
        path: z.string().default(".").describe("Directory path relative to repo root."),
      }),
      execute: async ({ path }) => {
        try {
          const abs = safeResolve(ctx.repoDir, path);
          const entries = readdirSync(abs).slice(0, MAX_DIR_ENTRIES);
          const items = entries.map((name) => {
            const s = statSync(join(abs, name));
            return { name, type: s.isDirectory() ? "dir" : "file", size: s.size };
          });
          return { ok: true, path, items };
        } catch (err) {
          return { ok: false, path, error: errMsg(err) };
        }
      },
    }),

    grep: tool({
      description:
        "Search the repo for a regex pattern. Uses ripgrep if available, otherwise a slower fallback. Returns up to 200 matches.",
      parameters: z.object({
        pattern: z.string(),
        glob: z.string().optional().describe("Optional glob to scope the search, e.g. '*.ts'."),
      }),
      execute: async ({ pattern, glob }) => {
        const args = ["--no-heading", "--line-number", "--max-count", "5", pattern];
        if (glob) args.push("-g", glob);
        const proc = spawnSync("rg", args, {
          cwd: ctx.repoDir,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        });
        if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: false, error: "ripgrep (rg) not installed on this runner" };
        }
        if (proc.status === 1) return { ok: true, matches: [] };
        if (proc.status !== 0) {
          return { ok: false, error: proc.stderr || `rg exited ${proc.status}` };
        }
        const matches = proc.stdout.split("\n").filter(Boolean).slice(0, MAX_GREP_RESULTS);
        return { ok: true, matches };
      },
    }),

    view_pr_metadata: tool({
      description: "Get PR title, body, base/head branches, labels, and commit messages.",
      parameters: z.object({}),
      execute: async () => {
        const { data: pr } = await ctx.octokit.pulls.get({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.prNumber,
        });
        const { data: commits } = await ctx.octokit.pulls.listCommits({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.prNumber,
          per_page: 100,
        });
        return {
          ok: true,
          title: pr.title,
          body: pr.body ?? "",
          base: pr.base.ref,
          head: pr.head.ref,
          head_sha: pr.head.sha,
          labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name)),
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files,
          commits: commits.map((c) => ({
            sha: c.sha,
            message: c.commit.message,
            author: c.commit.author?.name,
          })),
        };
      },
    }),

    view_diff: tool({
      description:
        "Get the unified diff for the entire PR. Useful as a starting point. Truncated if very large.",
      parameters: z.object({}),
      execute: async () => {
        const response = await ctx.octokit.pulls.get({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.prNumber,
          mediaType: { format: "diff" },
        });
        const diff = response.data as unknown as string;
        return { ok: true, diff: truncate(diff, 600_000) };
      },
    }),

    view_file_at_base: tool({
      description: "Read a file as it exists in the PR's base branch (before the PR's changes).",
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        try {
          const { data: pr } = await ctx.octokit.pulls.get({
            owner: ctx.owner,
            repo: ctx.repo,
            pull_number: ctx.prNumber,
          });
          const { data } = await ctx.octokit.repos.getContent({
            owner: ctx.owner,
            repo: ctx.repo,
            path,
            ref: pr.base.sha,
          });
          if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
            return { ok: false, error: "not a file" };
          }
          const content = Buffer.from(data.content, "base64").toString("utf8");
          return { ok: true, path, content: truncate(content, MAX_FILE_BYTES) };
        } catch (err) {
          return { ok: false, path, error: errMsg(err) };
        }
      },
    }),
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[... truncated at ${max} bytes ...]`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
