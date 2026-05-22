import type { AppCredentials, ServerConfig } from "@rex/shared";

export interface ServerContext {
  config: ServerConfig;
  creds: AppCredentials;
  webhookSecret: string;
}
