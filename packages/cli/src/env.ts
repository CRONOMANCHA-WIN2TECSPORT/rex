import type { Command } from "@rex/shared";

export interface CliEnv {
  command: Command;
  model: string;
  appToken: string;
  repoDir: string;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number | null;
  prompt: string;
  headSha: string;
}

export function readEnv(): CliEnv {
  const command = required("REX_COMMAND") as Command;
  if (command !== "review" && command !== "fix") {
    throw new Error(`unknown REX_COMMAND: ${command}`);
  }
  const repository = required("REX_REPOSITORY");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`invalid REX_REPOSITORY: ${repository}`);

  return {
    command,
    model: required("REX_MODEL"),
    appToken: required("REX_APP_TOKEN"),
    repoDir: required("REX_REPO_DIR"),
    owner,
    repo,
    prNumber: Number(required("REX_PR_NUMBER")),
    commentId: process.env.REX_COMMENT_ID ? Number(process.env.REX_COMMENT_ID) : null,
    prompt: process.env.REX_PROMPT ?? "",
    headSha: process.env.REX_HEAD_SHA ?? "",
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}
