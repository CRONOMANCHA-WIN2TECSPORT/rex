import { jwtVerify, createRemoteJWKSet } from "jose";

const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS = createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`));

export interface GitHubOIDCClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  repository: string;
  repository_owner: string;
  repository_id: string;
  run_id: string;
  actor: string;
  actor_id: string;
  workflow: string;
  event_name: string;
  ref: string;
  job_workflow_ref: string;
}

export async function validateOIDC(token: string, audience: string): Promise<GitHubOIDCClaims> {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience,
  });
  return payload as unknown as GitHubOIDCClaims;
}

export function splitRepository(claims: GitHubOIDCClaims): { owner: string; repo: string } {
  const parts = claims.repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repository claim: ${claims.repository}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function extractBearer(authHeader: string | undefined | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const t = authHeader.slice(7).trim();
  return t || null;
}
