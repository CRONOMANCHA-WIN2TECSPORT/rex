import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { exchangeRoute } from "./routes/exchange.js";
import { webhookRoute } from "./routes/webhook.js";
import type { ServerContext } from "./context.js";

function buildApp(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({ name: "rex", ok: true, allowlist: ctx.config.allowlist }),
  );
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/auth", exchangeRoute(ctx));
  app.route("/", webhookRoute(ctx));

  return app;
}

function main() {
  const loaded = loadConfig();
  const ctx: ServerContext = {
    config: loaded.config,
    creds: {
      appId: loaded.config.github_app.app_id,
      privateKey: loaded.privateKey,
    },
    webhookSecret: loaded.webhookSecret,
  };
  const app = buildApp(ctx);
  const port = ctx.config.port;

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      JSON.stringify({
        event: "server_started",
        port: info.port,
        allowlist: ctx.config.allowlist,
        oidc_audience: ctx.config.oidc.audience,
      }),
    );
  });
}

main();
