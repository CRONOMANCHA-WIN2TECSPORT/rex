import { z } from "zod";

export const COMMANDS = ["review", "fix"] as const;
export type Command = (typeof COMMANDS)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "bug",
  "security",
  "perf",
  "style",
  "design",
  "docs",
  "tests",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  path: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  message: z.string().min(1),
  suggestion: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewSubmissionSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(FindingSchema),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export const FileEditSchema = z.object({
  path: z.string().min(1),
  oldStr: z.string(),
  newStr: z.string(),
});
export type FileEdit = z.infer<typeof FileEditSchema>;

export const FixSubmissionSchema = z.object({
  summary: z.string().min(1),
  changes: z.array(FileEditSchema),
});
export type FixSubmission = z.infer<typeof FixSubmissionSchema>;

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
      max_steps: z.number().int().positive().default(30),
      max_tokens_per_call: z.number().int().positive().default(8000),
      timeout_minutes: z.number().int().positive().default(30),
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
