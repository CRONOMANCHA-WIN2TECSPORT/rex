import type { Octokit } from "@octokit/rest";
import type { ReviewSubmission } from "@rex/shared";
import { renderReviewBody, renderInlineComment } from "../render/summary.js";

export interface PostReviewArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  submission: ReviewSubmission;
}

export async function postReview(args: PostReviewArgs): Promise<void> {
  const body = renderReviewBody(args.submission);

  // Build inline comments. Findings without a path/line stay in the summary body only.
  const comments = args.submission.findings
    .filter((f) => f.path && f.line)
    .map((f) => {
      const c: {
        path: string;
        body: string;
        line: number;
        side: "RIGHT";
        start_line?: number;
        start_side?: "RIGHT";
      } = {
        path: f.path,
        body: renderInlineComment(f),
        line: f.line,
        side: "RIGHT",
      };
      if (f.endLine && f.endLine > f.line) {
        c.start_line = f.line;
        c.start_side = "RIGHT";
        c.line = f.endLine;
      }
      return c;
    });

  const hasSevereIssues = args.submission.findings.some(
    (f) => f.severity === "critical" || f.severity === "high"
  );
  let event: "REQUEST_CHANGES" | "APPROVE" | "COMMENT" = "COMMENT";
  if (hasSevereIssues) {
    event = "REQUEST_CHANGES";
  } else if (args.submission.findings.length === 0) {
    event = "APPROVE";
  }

  try {
    await args.octokit.pulls.createReview({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.prNumber,
      commit_id: args.headSha || undefined,
      event,
      body,
      comments: comments.length > 0 ? comments : undefined,
    });
  } catch (err) {
    // Fallback: createReview rejects when lines are outside the diff hunks.
    // Post the summary as an issue comment + each finding as a separate (best-effort) inline.
    console.error(
      JSON.stringify({
        event: "create_review_failed_falling_back",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    await args.octokit.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.prNumber,
      body,
    });
    for (const c of comments) {
      try {
        await args.octokit.pulls.createReviewComment({
          owner: args.owner,
          repo: args.repo,
          pull_number: args.prNumber,
          commit_id: args.headSha,
          path: c.path,
          line: c.line,
          side: c.side,
          start_line: c.start_line,
          start_side: c.start_side,
          body: c.body,
        });
      } catch (innerErr) {
        // Outside-of-diff finding — surface in a follow-up issue comment.
        await args.octokit.issues.createComment({
          owner: args.owner,
          repo: args.repo,
          issue_number: args.prNumber,
          body:
            `**rex finding outside diff** at \`${c.path}:${c.line}\`\n\n${c.body}\n\n` +
            `<sub>(${innerErr instanceof Error ? innerErr.message : "unknown"})</sub>`,
        });
      }
    }
  }
}
