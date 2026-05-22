import type { FixSubmission } from "@rex/shared";
import type { ApplyFixResult } from "../github/fix.js";

export function renderFixSuccess(
  submission: FixSubmission,
  outcome: ApplyFixResult,
  serverUrl: string,
  owner: string,
  repo: string,
): string {
  const commitUrl =
    outcome.commitSha && `${serverUrl}/${owner}/${repo}/commit/${outcome.commitSha}`;

  const files = outcome.appliedFiles.map((p) => `- \`${p}\``).join("\n");
  const skipped =
    outcome.skipped.length > 0
      ? "\n\n**Skipped:**\n" +
        outcome.skipped.map((s) => `- \`${s.path}\` — ${s.reason}`).join("\n")
      : "";

  return [
    "## 🦖 rex fix",
    "",
    submission.summary.trim(),
    "",
    `**Pushed:** [\`${(outcome.commitSha ?? "").slice(0, 7)}\`](${commitUrl}) on \`${outcome.branch}\``,
    "",
    "**Files changed:**",
    files,
    skipped,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderFixSkipped(
  submission: FixSubmission | null,
  outcome: ApplyFixResult,
): string {
  const summary = submission?.summary.trim() ?? "(no summary)";
  const skipped =
    outcome.skipped.length > 0
      ? "\n\n**Skipped:**\n" +
        outcome.skipped.map((s) => `- \`${s.path}\` — ${s.reason}`).join("\n")
      : "";
  return [
    "## 🦖 rex fix — no changes pushed",
    "",
    `**Reason:** ${outcome.reason ?? "no edits applied"}`,
    "",
    summary,
    skipped,
  ].join("\n");
}
