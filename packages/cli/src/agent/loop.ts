import { generateText, type LanguageModel } from "ai";
import { buildReviewTools, buildFixTools, type ToolContext } from "./tools.js";
import { REVIEW_SYSTEM_PROMPT, FIX_SYSTEM_PROMPT } from "@rex/shared";
import type { Command, FixSubmission, ReviewSubmission } from "@rex/shared";

const MAX_STEPS = 30;

export interface AgentInput {
  command: Command;
  model: LanguageModel;
  toolCtx: ToolContext;
  userPrompt: string;
  prTitle: string;
}

export interface ReviewAgentOutput {
  kind: "review";
  submission: ReviewSubmission | null;
  steps: number;
  finishReason: string;
}

export interface FixAgentOutput {
  kind: "fix";
  submission: FixSubmission | null;
  steps: number;
  finishReason: string;
}

export type AgentOutput = ReviewAgentOutput | FixAgentOutput;

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const userMessage = buildUserMessage(input);

  if (input.command === "review") {
    const { tools, result } = buildReviewTools(input.toolCtx);
    const out = await generateText({
      model: input.model,
      system: REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      tools,
      maxSteps: MAX_STEPS,
    });
    return {
      kind: "review",
      submission: result.current,
      steps: out.steps?.length ?? 0,
      finishReason: out.finishReason ?? "unknown",
    };
  }

  const { tools, result } = buildFixTools(input.toolCtx);
  const out = await generateText({
    model: input.model,
    system: FIX_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools,
    maxSteps: MAX_STEPS,
  });
  return {
    kind: "fix",
    submission: result.current,
    steps: out.steps?.length ?? 0,
    finishReason: out.finishReason ?? "unknown",
  };
}

function buildUserMessage(input: AgentInput): string {
  const ctx = input.toolCtx;
  const parts = [
    `Pull request: ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`,
    `Title: ${input.prTitle}`,
    "",
    "Use the tools to inspect the PR and the repo, then submit your result.",
  ];
  if (input.userPrompt.trim()) {
    parts.push("", `Author note: ${input.userPrompt.trim()}`);
  }
  return parts.join("\n");
}
