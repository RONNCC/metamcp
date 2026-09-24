// Generic OAuth loopback forwarder — runs one dedicated listener per entry
// in @repo/zod-types' OAUTH_LOOPBACK_PROVIDERS. See that module for why this
// exists (providers with no dynamic client registration, e.g. Slack).
//
// Deliberately NOT routes on the main Express `app` — that would make each
// listener reachable on whatever port carries the rest of the gateway's
// surface (trpc, mcp-proxy, admin). Each provider gets its own dedicated
// listener that understands exactly one path on its own port.
import http from "http";
import { URL } from "url";

import { OAUTH_LOOPBACK_PROVIDERS, OAuthLoopbackProvider } from "@repo/zod-types";

import logger from "../utils/logger";

function startForwarder(provider: OAuthLoopbackProvider): void {
  const server = http.createServer((req, res) => {
    const appUrl = process.env.APP_URL;
    if (!appUrl) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("APP_URL is not configured");
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? "/", `http://localhost:${provider.port}`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad request");
      return;
    }

    if (req.method !== "GET" || requestUrl.pathname !== provider.callbackPath) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const target = new URL("/fe-oauth/callback", appUrl);
    target.search = requestUrl.search;
    res.writeHead(302, { Location: target.toString() });
    res.end();
  });

  server.on("error", (err) => {
    // Non-fatal: a busy port disables this provider's loopback path but
    // must not crash the gateway (every other connector's OAuth flow is
    // unaffected).
    logger.error(
      `OAuth loopback forwarder for ${provider.hostname} failed to bind port ${provider.port} (its OAuth flow will not work until this is resolved):`,
      err,
    );
  });

  server.listen(provider.port, () => {
    logger.info(
      `OAuth loopback forwarder for ${provider.hostname} listening on http://localhost:${provider.port}${provider.callbackPath}`,
    );
  });
}

export function startOAuthLoopbackForwarders(): void {
  for (const provider of OAUTH_LOOPBACK_PROVIDERS) {
    startForwarder(provider);
  }
}
