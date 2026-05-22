import type { Octokit } from "@octokit/rest";

export interface PRSummary {
  title: string;
  body: string;
  base: string;
  head: string;
  headSha: string;
  changedFiles: number;
}

export async function fetchPRSummary(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRSummary> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    title: data.title,
    body: data.body ?? "",
    base: data.base.ref,
    head: data.head.ref,
    headSha: data.head.sha,
    changedFiles: data.changed_files,
  };
}
