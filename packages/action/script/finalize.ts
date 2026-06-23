import { Octokit } from "@octokit/rest";
import { safeErr, applyTriageLabel } from "@rex/shared";

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

  // success/skipped/empty → nothing to do. GitHub Actions reports "skipped"
  // when an upstream step failed and the run step never executed.
  if (outcome === "success" || outcome === "") return;
  if (!appToken || !repo || !targetNumber) {
    console.log(
      JSON.stringify({ event: "finalize_skip", reason: "missing app token / repo / target" }),
    );
    return;
  }

  const [owner, repoName] = repo.split("/");
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
