import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { deepseek } from "@ai-sdk/deepseek";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// `provider/model` → AI SDK LanguageModel.
// Each provider reads its API key from a conventional env var:
//   anthropic → ANTHROPIC_API_KEY
//   openai    → OPENAI_API_KEY
//   deepseek  → DEEPSEEK_API_KEY
//   google    → GOOGLE_GENERATIVE_AI_API_KEY
export function resolveModel(spec: string): LanguageModel {
  const [provider, ...modelParts] = spec.split("/");
  const model = modelParts.join("/");
  if (!provider || !model) {
    throw new Error(`invalid model spec '${spec}', expected provider/model`);
  }
  switch (provider.toLowerCase()) {
    case "anthropic":
      return anthropic(model);
    case "openai":
      return openai(model);
    case "deepseek":
      return deepseek(model);
    case "google":
    case "gemini":
      return google(model);
    default:
      throw new Error(
        `unsupported provider '${provider}'. Supported: anthropic, openai, deepseek, google`,
      );
  }
}
