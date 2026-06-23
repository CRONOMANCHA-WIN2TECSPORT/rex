// Triage label vocabulary + a deterministic applier shared by the two places
// that set triage state: `post_triage.ts` (the model decided verified/reproduced/
// skipped) and `finalize.ts` (the harness marks `failed` when OpenCode crashed or
// hit the retry cap, which the model can never report itself).
//
// The four states are mutually exclusive — applying one removes the others so an
// issue never carries a stale `triage/reproduced` next to a fresh `triage/failed`.

import type { Octokit } from "@octokit/rest";

export interface TriageLabel {
  name: string;
  color: string; // 6-hex, no leading '#'
  description: string;
}

export const TRIAGE_LABELS = {
  // Bug reproduced AND a simple fix is known — the model includes the fix.
  verified: {
    name: "triage/verified",
    color: "0e8a16",
    description: "Rex reproduced the bug and provided a simple fix",
  },
  // Bug confirmed to exist by code inspection (no fix attached).
  reproduced: {
    name: "triage/reproduced",
    color: "d93f0b",
    description: "Rex reproduced the bug by code inspection",
  },
  // The model declined to keep investigating (inconclusive / out of scope).
  skipped: {
    name: "triage/skipped",
    color: "cccccc",
    description: "Rex declined to investigate the bug further",
  },
  // OpenCode crashed or hit the retry cap — set by finalize.ts, never the model.
  failed: {
    name: "triage/failed",
    color: "b60205",
    description: "Rex crashed or hit the retry cap during triage",
  },
} as const satisfies Record<string, TriageLabel>;

export type TriageStatus = keyof typeof TRIAGE_LABELS;

export const TRIAGE_STATUSES = Object.keys(TRIAGE_LABELS) as TriageStatus[];

export function isTriageStatus(v: unknown): v is TriageStatus {
  return typeof v === "string" && (TRIAGE_STATUSES as string[]).includes(v);
}

// Ensure the target label exists (create it if the repo never used rex triage
// before), strip the other three triage/* labels off the issue, then apply the
// target. Best-effort on the removals — a missing label is not an error.
export async function applyTriageLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issue_number: number,
  status: TriageStatus,
): Promise<void> {
  const target = TRIAGE_LABELS[status];

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
    TRIAGE_STATUSES.filter((s) => s !== status).map((s) => TRIAGE_LABELS[s].name),
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
