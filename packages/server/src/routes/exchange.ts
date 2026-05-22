import { Hono } from "hono";
import { z } from "zod";
import {
  generateInstallationToken,
  lookupInstallationId,
  resolvePermissions,
  type TokenPermissionsInput,
} from "@rex/shared";
import { checkAllowlist } from "../allowlist.js";
import { extractBearer, splitRepository, validateOIDC } from "../oidc.js";
import type { ServerContext } from "../context.js";

const BodySchema = z.object({
  permissions: z
    .union([
      z.enum(["NO_PUSH", "WRITE"]),
      z.object({
        contents: z.enum(["read", "write"]).optional(),
        issues: z.enum(["read", "write"]).optional(),
        pull_requests: z.enum(["read", "write"]).optional(),
        metadata: z.literal("read").optional(),
      }),
    ])
    .optional(),
});

export function exchangeRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/exchange_github_app_token", async (c) => {
    const oidcToken = extractBearer(c.req.header("authorization"));
    if (!oidcToken) {
      return c.json({ error: "missing bearer token" }, 401);
    }

    let claims;
    try {
      claims = await validateOIDC(oidcToken, ctx.config.oidc.audience);
    } catch (err) {
      return c.json({ error: "invalid OIDC token", detail: errMsg(err) }, 401);
    }

    const { owner, repo } = splitRepository(claims);

    const allow = checkAllowlist(ctx.config.allowlist, {
      owner,
      repo,
      actor: claims.actor,
    });
    if (!allow.ok) {
      console.log(
        JSON.stringify({
          event: "exchange_denied",
          reason: allow.reason,
          owner,
          repo,
          actor: claims.actor,
          run_id: claims.run_id,
        }),
      );
      return c.json({ error: "not allowed", reason: allow.reason }, 403);
    }

    const parsed = BodySchema.safeParse(await safeJson(c));
    if (!parsed.success) {
      return c.json({ error: "invalid body", detail: parsed.error.flatten() }, 400);
    }

    const permissions = resolvePermissions(parsed.data.permissions as TokenPermissionsInput);

    let installationId: number;
    try {
      installationId = await lookupInstallationId(ctx.creds, owner, repo);
    } catch (err) {
      return c.json({ error: "app not installed", detail: errMsg(err) }, 404);
    }

    let token: string;
    try {
      token = await generateInstallationToken(ctx.creds, installationId, {
        repositoryNames: [repo],
        permissions,
      });
    } catch (err) {
      return c.json({ error: "token generation failed", detail: errMsg(err) }, 500);
    }

    console.log(
      JSON.stringify({
        event: "token_exchanged",
        owner,
        repo,
        actor: claims.actor,
        run_id: claims.run_id,
        permissions,
      }),
    );

    return c.json({ token, permissions });
  });

  return app;
}

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
