import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";
import type { TokenPermissions, TokenPermissionsInput } from "./types.js";

// @octokit/auth-app v8 typing models StrategyOptions as a union that includes
// a `createJwt` variant; passing { appId, privateKey } satisfies it at runtime
// but TS can't narrow through the union + Record<string, unknown> intersection.
// We pass options through this helper instead of inline.
type AppAuthOpts = Parameters<typeof createAppAuth>[0];
function appAuthOpts(creds: AppCredentials, installationId?: number): AppAuthOpts {
  if (installationId !== undefined) {
    return { appId: creds.appId, privateKey: creds.privateKey, installationId } as AppAuthOpts;
  }
  return { appId: creds.appId, privateKey: creds.privateKey } as AppAuthOpts;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
}

const DEFAULT_PERMISSIONS: Required<TokenPermissions> = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
};

const PRESETS: Record<"NO_PUSH" | "WRITE", Required<TokenPermissions>> = {
  NO_PUSH: {
    contents: "read",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
  WRITE: { ...DEFAULT_PERMISSIONS },
};

const RANK: Record<string, number> = { read: 0, write: 1 };

// Resolves preset name or custom permissions object into concrete permissions.
// Custom objects are downgrade-only — caller can never escalate beyond defaults.
// Unknown values fail closed to NO_PUSH.
export function resolvePermissions(input?: TokenPermissionsInput): Required<TokenPermissions> {
  if (!input) return { ...DEFAULT_PERMISSIONS };

  if (typeof input === "string") {
    const preset = PRESETS[input.toUpperCase() as "NO_PUSH" | "WRITE"];
    return preset ? { ...preset } : { ...PRESETS.NO_PUSH };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    return { ...PRESETS.NO_PUSH };
  }

  const resolved = { ...DEFAULT_PERMISSIONS };
  let anyAccepted = false;
  for (const key of Object.keys(DEFAULT_PERMISSIONS) as (keyof TokenPermissions)[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (value !== "read" && value !== "write") continue;
    anyAccepted = true;
    const defaultRank = RANK[resolved[key]] ?? 0;
    const requestedRank = RANK[value];
    if (requestedRank <= defaultRank) {
      (resolved as Record<string, string>)[key] = value;
    }
  }
  if (!anyAccepted && Object.keys(input).length > 0) {
    return { ...PRESETS.NO_PUSH };
  }
  return resolved;
}

export function createWebhooks(secret: string): Webhooks {
  return new Webhooks({ secret });
}

export interface VerifiedWebhook {
  id: string;
  name: string;
  payload: Record<string, unknown>;
}

export async function verifyAndParseWebhook(
  webhooks: Webhooks,
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<VerifiedWebhook> {
  const id = headers["x-github-delivery"];
  const name = headers["x-github-event"];
  const signature = headers["x-hub-signature-256"];
  if (!id || !name || !signature) {
    throw new Error("missing webhook headers");
  }
  const valid = await webhooks.verify(rawBody, signature);
  if (!valid) {
    throw new Error("invalid webhook signature");
  }
  return { id, name, payload: JSON.parse(rawBody) };
}

export async function createAppOctokit(creds: AppCredentials): Promise<Octokit> {
  const auth = createAppAuth(appAuthOpts(creds));
  const { token } = await auth({ type: "app" });
  return new Octokit({ auth: token });
}

export async function createInstallationOctokit(
  creds: AppCredentials,
  installationId: number,
): Promise<Octokit> {
  const auth = createAppAuth(appAuthOpts(creds, installationId));
  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

export interface InstallationTokenOptions {
  repositoryNames?: string[];
  permissions?: TokenPermissions;
}

export async function generateInstallationToken(
  creds: AppCredentials,
  installationId: number,
  options?: InstallationTokenOptions,
): Promise<string> {
  const auth = createAppAuth(appAuthOpts(creds, installationId));
  const result = await auth({
    type: "installation",
    repositoryNames: options?.repositoryNames,
    permissions: options?.permissions,
  });
  return result.token;
}

export async function lookupInstallationId(
  creds: AppCredentials,
  owner: string,
  repo: string,
): Promise<number> {
  const octokit = await createAppOctokit(creds);
  const { data } = await octokit.apps.getRepoInstallation({ owner, repo });
  return data.id;
}
