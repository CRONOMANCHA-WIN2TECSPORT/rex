import { Octokit } from "@octokit/rest";
import { readEnv } from "./env.js";
import { resolveModel } from "./agent/providers.js";
import { runAgent } from "./agent/loop.js";
import { fetchPRSummary } from "./github/pr.js";
import { postReview } from "./github/posting.js";
import { applyFix } from "./github/fix.js";
import { renderFixSuccess, renderFixSkipped } from "./render/fixSummary.js";

async function main(): Promise<void> {
  const env = readEnv();
  const octokit = new Octokit({ auth: env.appToken });

  const pr = await fetchPRSummary(octokit, env.owner, env.repo, env.prNumber);
  const headSha = env.headSha || pr.headSha;

  console.log(
    JSON.stringify({
      event: "rex_start",
      command: env.command,
      model: env.model,
      pr: `${env.owner}/${env.repo}#${env.prNumber}`,
      head_sha: headSha,
    }),
  );

  const output = await runAgent({
    command: env.command,
    model: resolveModel(env.model),
    toolCtx: {
      repoDir: env.repoDir,
      octokit,
      owner: env.owner,
      repo: env.repo,
      prNumber: env.prNumber,
      headSha,
    },
    userPrompt: env.prompt,
    prTitle: pr.title,
  });

  console.log(
    JSON.stringify({
      event: "rex_agent_done",
      kind: output.kind,
      steps: output.steps,
      finish_reason: output.finishReason,
      submitted: output.submission !== null,
    }),
  );

  if (output.kind === "review") {
    if (!output.submission) {
      throw new Error(
        `agent finished without calling submit_review (finish_reason=${output.finishReason})`,
      );
    }
    await postReview({
      octokit,
      owner: env.owner,
      repo: env.repo,
      prNumber: env.prNumber,
      headSha,
      submission: output.submission,
    });
    console.log(
      JSON.stringify({
        event: "rex_posted",
        findings: output.submission.findings.length,
      }),
    );
    return;
  }

  // command === "fix"
  if (!output.submission) {
    throw new Error(
      `agent finished without calling submit_fix (finish_reason=${output.finishReason})`,
    );
  }

  const fixOutcome = await applyFix({
    octokit,
    owner: env.owner,
    repo: env.repo,
    prNumber: env.prNumber,
    repoDir: env.repoDir,
    submission: output.submission,
  });

  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const body = fixOutcome.pushed
    ? renderFixSuccess(output.submission, fixOutcome, serverUrl, env.owner, env.repo)
    : renderFixSkipped(output.submission, fixOutcome);

  await octokit.issues.createComment({
    owner: env.owner,
    repo: env.repo,
    issue_number: env.prNumber,
    body,
  });

  console.log(
    JSON.stringify({
      event: "rex_fix_done",
      pushed: fixOutcome.pushed,
      commit: fixOutcome.commitSha,
      branch: fixOutcome.branch,
      applied: fixOutcome.appliedFiles.length,
      skipped: fixOutcome.skipped.length,
      reason: fixOutcome.reason,
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "rex_error",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
