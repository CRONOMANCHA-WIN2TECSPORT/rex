// Review label vocabulary + a deterministic applier, mirroring the triage label
// pattern in triage.ts. Applied by post_review.ts after publishing the review.
//
// Two mutually exclusive labels reflect the bot's verdict:
// - rex/needs-review  — REQUEST_CHANGES, or COMMENT with inline findings
// - rex/approved      — APPROVE, or COMMENT with zero findings
//
// Applying one removes the other so a PR never carries a stale rex/needs-review
// next to a fresh rex/approved.

import type { Octokit } from "@octokit/rest";

export interface ReviewLabel {
  name: string;
  color: string; // 6-hex, no leading '#'
  description: string;
}

export const REVIEW_LABELS = {
  "needs-review": {
    name: "rex/needs-review",
    color: "d93f0b",
    description: "Rex flagged issues that need attention before merge",
  },
  approved: {
    name: "rex/approved",
    color: "0e8a16",
    description: "Rex found no issues — OK to merge",
  },
} as const satisfies Record<string, ReviewLabel>;

export type ReviewLabelStatus = keyof typeof REVIEW_LABELS;

const REVIEW_LABEL_STATUSES = Object.keys(REVIEW_LABELS) as ReviewLabelStatus[];

// Ensure the target label exists (create it if the repo never used rex review
// labels before), strip the other rex/* review label off the PR, then apply the
// target. Best-effort on the removal — a missing label is not an error.
export async function applyReviewLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
  status: ReviewLabelStatus,
): Promise<void> {
  const target = REVIEW_LABELS[status];

  try {
    await octokit.issues.getLabel({ owner, repo, name: target.name });
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      await octokit.issues.createLabel({
        owner,
        repo,
        name: target.name,
        color: target.color,
        description: target.description,
      });
    } else {
      throw err;
    }
  }

  const others = new Set<string>(
    REVIEW_LABEL_STATUSES.filter((s) => s !== status).map((s) => REVIEW_LABELS[s].name),
  );
  try {
    const current = await octokit.issues.listLabelsOnIssue({ owner, repo, issue_number });
    for (const l of current.data) {
      if (others.has(l.name)) {
        await octokit.issues
          .removeLabel({ owner, repo, issue_number, name: l.name })
          .catch(() => undefined);
      }
    }
  } catch {
    // Listing labels failed — not fatal; we still apply the target below.
  }

  await octokit.issues.addLabels({ owner, repo, issue_number, labels: [target.name] });
}
