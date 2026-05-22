import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ServerConfigSchema, type ServerConfig } from "@rex/shared";

const CONFIG_PATH_ENV = "REX_CONFIG_PATH";
const DEFAULT_CONFIG_PATH = "./rex.config.yml";

export interface LoadedConfig {
  config: ServerConfig;
  privateKey: string;
  webhookSecret: string;
}

export function loadConfig(): LoadedConfig {
  const path = process.env[CONFIG_PATH_ENV] ?? DEFAULT_CONFIG_PATH;
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const config = ServerConfigSchema.parse(parsed);

  const privateKey = resolvePrivateKey(config);
  const webhookSecret = requireEnv(config.github_app.webhook_secret_env);

  return { config, privateKey, webhookSecret };
}

function resolvePrivateKey(config: ServerConfig): string {
  if (config.github_app.private_key_path) {
    return readFileSync(config.github_app.private_key_path, "utf8");
  }
  return requireEnv(config.github_app.private_key_env);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}
