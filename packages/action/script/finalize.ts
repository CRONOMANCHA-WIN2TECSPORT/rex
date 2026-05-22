import { Octokit } from "@octokit/rest";

async function main() {
  const appToken = process.env.REX_APP_TOKEN;
  const repo = process.env.REX_REPOSITORY;
  const prNumber = process.env.REX_PR_NUMBER;
  const outcome = process.env.OPENCODE_STATUS ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";

  // success/skipped/empty → nothing to do. GitHub Actions reports "skipped"
  // when an upstream step failed and the run step never executed.
  if (outcome === "success" || outcome === "") return;
  if (!appToken || !repo || !prNumber) {
    console.log(
      JSON.stringify({ event: "finalize_skip", reason: "missing app token / repo / pr" }),
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
      issue_number: Number(prNumber),
      body,
    });
    console.log(JSON.stringify({ event: "finalize_posted", outcome }));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "finalize_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

main();
