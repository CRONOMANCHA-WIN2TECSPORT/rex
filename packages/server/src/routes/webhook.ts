import { Hono } from "hono";
import { createWebhooks, verifyAndParseWebhook } from "@rex/shared";
import { checkAllowlist } from "../allowlist.js";
import type { ServerContext } from "../context.js";

export function webhookRoute(ctx: ServerContext): Hono {
  const app = new Hono();
  const webhooks = createWebhooks(ctx.webhookSecret);

  app.post("/webhooks", async (c) => {
    const rawBody = await c.req.text();
    const headers: Record<string, string | undefined> = {
      "x-github-delivery": c.req.header("x-github-delivery"),
      "x-github-event": c.req.header("x-github-event"),
      "x-hub-signature-256": c.req.header("x-hub-signature-256"),
    };

    let evt;
    try {
      evt = await verifyAndParseWebhook(webhooks, headers, rawBody);
    } catch (err) {
      return c.json({ error: "invalid webhook", detail: errMsg(err) }, 400);
    }

    const meta = extractMeta(evt.name, evt.payload);
    if (meta) {
      const allow = checkAllowlist(ctx.config.allowlist, meta);
      console.log(
        JSON.stringify({
          event: "webhook",
          name: evt.name,
          delivery: evt.id,
          ...meta,
          allowed: allow.ok,
          reason: allow.reason,
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          event: "webhook",
          name: evt.name,
          delivery: evt.id,
          note: "no actor/repo in payload",
        }),
      );
    }

    // Phase 1: tracking-only. The GitHub Action listens to issue_comment
    // directly; the gate is the OIDC exchange. Later phases will use this
    // path for failure comments and edit-in-place status updates.
    return c.json({ ok: true });
  });

  return app;
}

function extractMeta(
  name: string,
  payload: Record<string, unknown>,
): { owner: string; repo: string; actor: string } | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;
  const owner = (repo?.owner as Record<string, unknown> | undefined)?.login;
  const repoName = repo?.name;
  const actor = sender?.login;
  if (typeof owner !== "string" || typeof repoName !== "string" || typeof actor !== "string") {
    return null;
  }
  return { owner, repo: repoName, actor };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
