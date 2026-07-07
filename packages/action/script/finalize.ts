import { Octokit } from "@octokit/rest";
import { safeErr, applyTriageLabel } from "@rex/shared";

// Commands whose real output is published by a deterministic post-step
// (post_review.ts / post_triage.ts). For these, the comment `opencode github
// run` posts with the model's final response is always a duplicate.
const VALIDATED_COMMANDS = new Set(["review", "triage"]);

// `opencode github run` unconditionally posts the model's final response as an
// issue comment — there is no flag to suppress it (see createComment() in
// opencode's github.handler.ts). We can't prevent it, so we delete it after
// the fact, identified by the per-run footer link opencode appends:
// `[github run](/owner/repo/actions/runs/<run_id>)`.
async function deleteOpencodeAutoComment(
  octokit: Octokit,
  owner: string,
  repoName: string,
  issueNumber: number,
  repo: string,
  runId: string,
) {
  const marker = `(/${repo}/actions/runs/${runId})`;
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo: repoName,
    issue_number: issueNumber,
    per_page: 100,
  });
  for (const comment of comments) {
    if (comment.user?.type !== "Bot" || !comment.body?.includes(marker)) continue;
    await octokit.issues.deleteComment({ owner, repo: repoName, comment_id: comment.id });
    console.log(
      JSON.stringify({ event: "finalize_deleted_auto_comment", comment_id: comment.id }),
    );
  }
}

async function main() {
  const appToken = process.env.REX_APP_TOKEN;
  const repo = process.env.REX_REPOSITORY;
  // REX_TARGET_NUMBER is the PR number for review/fix and the issue number for
  // triage; fall back to REX_PR_NUMBER for older callers.
  const targetNumber = process.env.REX_TARGET_NUMBER || process.env.REX_PR_NUMBER;
  const command = process.env.REX_COMMAND ?? "";
  const outcome = process.env.OPENCODE_STATUS ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";

  // Empty/skipped → nothing ran, nothing to do. GitHub Actions reports
  // "skipped" when an upstream step failed and the run step never executed.
  if (outcome === "") return;
  if (!appToken || !repo || !targetNumber) {
    console.log(
      JSON.stringify({ event: "finalize_skip", reason: "missing app token / repo / target" }),
    );
    return;
  }

  const [owner, repoName] = repo.split("/");

  if (outcome === "success") {
    // On failure we keep opencode's comment: it carries the error message,
    // which rex's generic failure comment below doesn't.
    if (VALIDATED_COMMANDS.has(command) && runId) {
      const octokit = new Octokit({ auth: appToken });
      try {
        await deleteOpencodeAutoComment(
          octokit,
          owner,
          repoName,
          Number(targetNumber),
          repo,
          runId,
        );
      } catch (err) {
        console.error(
          JSON.stringify({ event: "finalize_cleanup_failed", error: safeErr(err, [appToken]) }),
        );
      }
    }
    return;
  }
  const runUrl = `${serverUrl}/${repo}/actions/runs/${runId}`;
  const body = [
    "### Rex run failed",
    "",
    "The agent didn't complete successfully. Re-run the comment or check the logs:",
    "",
    runUrl,
  ].join("\n");

  const octokit = new Octokit({ auth: appToken });
  try {
    await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: Number(targetNumber),
      body,
    });
    // A crashed/timed-out triage run can never report its own state, so the
    // harness marks it failed here (this is the only place triage/failed is set).
    if (command === "triage") {
      await applyTriageLabel(octokit, owner, repoName, Number(targetNumber), "failed");
    }
    console.log(JSON.stringify({ event: "finalize_posted", outcome, command }));
  } catch (err) {
    console.error(
      JSON.stringify({ event: "finalize_failed", error: safeErr(err, [appToken]) }),
    );
  }
}

main();
