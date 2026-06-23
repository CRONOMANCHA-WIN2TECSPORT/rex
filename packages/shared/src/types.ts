import { z } from "zod";

export const COMMANDS = ["review", "fix", "triage"] as const;
export type Command = (typeof COMMANDS)[number];

export const AllowlistSchema = z.object({
  orgs: z.array(z.string()).default([]),
  repos: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
});
export type Allowlist = z.infer<typeof AllowlistSchema>;

export const ServerConfigSchema = z.object({
  github_app: z.object({
    app_id: z.union([z.number(), z.string()]).transform((v) => String(v)),
    private_key_path: z.string().optional(),
    private_key_env: z.string().default("GITHUB_APP_PRIVATE_KEY"),
    webhook_secret_env: z.string().default("REX_WEBHOOK_SECRET"),
  }),
  allowlist: AllowlistSchema.default({ orgs: [], repos: [], users: [] }),
  defaults: z
    .object({
      timeout_minutes: z.number().int().positive().default(45),
    })
    .default({}),
  oidc: z
    .object({
      audience: z.string().default("rex"),
    })
    .default({}),
  port: z.number().int().positive().default(3000),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export type TokenPermissionPreset = "NO_PUSH" | "WRITE";

export type TokenPermissions = {
  contents?: "read" | "write";
  issues?: "read" | "write";
  pull_requests?: "read" | "write";
  metadata?: "read";
};

export type TokenPermissionsInput = TokenPermissionPreset | TokenPermissions;
