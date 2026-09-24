import { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformation,
  OAuthClientInformationSchema,
  OAuthClientMetadata,
  OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { loopbackRedirectUriFor, loopbackScopeFor } from "@repo/zod-types";

import { getServerSpecificKey, SESSION_KEYS } from "./constants";
import { getAppUrl } from "./env";
import { vanillaTrpcClient } from "./trpc";

// OAuth client provider that works with a specific MCP server
class DbOAuthClientProvider implements OAuthClientProvider {
  private mcpServerUuid: string;
  protected serverUrl: string;

  constructor(mcpServerUuid: string, serverUrl: string) {
    this.mcpServerUuid = mcpServerUuid;
    this.serverUrl = serverUrl;
    // useConnection() instantiates this provider at render time, and that
    // render includes the server render of every page that hosts an MCP
    // connection. sessionStorage is browser-only, so writing it unconditionally
    // throws "sessionStorage is not defined" during SSR and turns the whole
    // route into a 500 before the client can hydrate. The write only keeps the
    // server URL in sync for the client-side OAuth flow (SERVER_URL is read back
    // exclusively in the browser), so it is skipped when web storage is absent;
    // the client re-runs the constructor on hydration and performs it then.
    if (typeof window !== "undefined") {
      sessionStorage.setItem(SESSION_KEYS.SERVER_URL, serverUrl);
    }
  }

  private get serverHostname(): string | undefined {
    try {
      return new URL(this.serverUrl).hostname;
    } catch {
      return undefined;
    }
  }

  get redirectUrl() {
    // Providers with no dynamic client registration (their redirect_uri
    // allowlist is a fixed set an admin configures by hand, exact-string-
    // matched per RFC 6749 §3.1.2) cannot know this deployment's APP_URL
    // ahead of time. Those get the RFC 8252 §7.3 loopback convention
    // Claude Code/VS Code already use — see @repo/zod-types'
    // OAUTH_LOOPBACK_PROVIDERS and apps/backend/src/lib/oauth-loopback-forwarder.ts,
    // which catches the provider's redirect there and forwards it here.
    // Every other connector gets the deployment-specific /fe-oauth/callback.
    const hostname = this.serverHostname;
    return (
      (hostname && loopbackRedirectUriFor(hostname)) ??
      getAppUrl() + "/fe-oauth/callback"
    );
  }

  get clientMetadata(): OAuthClientMetadata {
    const hostname = this.serverHostname;
    const scope = hostname ? loopbackScopeFor(hostname) : undefined;
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "MetaMCP",
      client_uri: "https://github.com/metatool-ai/metamcp",
      ...(scope ? { scope } : {}),
    };
  }

  // Check if the server exists in the database
  private async serverExists() {
    try {
      const result = await vanillaTrpcClient.frontend.mcpServers.get.query({
        uuid: this.mcpServerUuid,
      });
      return result.success && !!result.data;
    } catch (error) {
      console.error("Error checking server existence:", error);
      return false;
    }
  }

  // During OAuth flow, we use sessionStorage for temporary data
  // After successful authentication, we'll save to the database
  async clientInformation() {
    try {
      // Check if server exists in the database
      const exists = await this.serverExists();

      if (exists) {
        // Get from database if server exists
        const result = await vanillaTrpcClient.frontend.oauth.get.query({
          mcp_server_uuid: this.mcpServerUuid,
        });
        if (result.success && result.data?.client_information) {
          return await OAuthClientInformationSchema.parseAsync(
            result.data.client_information,
          );
        }
      } else {
        // Get from session storage during OAuth flow
        const key = getServerSpecificKey(
          SESSION_KEYS.CLIENT_INFORMATION,
          this.serverUrl,
        );
        const storedInfo = sessionStorage.getItem(key);
        if (storedInfo) {
          return await OAuthClientInformationSchema.parseAsync(
            JSON.parse(storedInfo),
          );
        }
      }

      return undefined;
    } catch (error) {
      console.error("Error retrieving client information:", error);
      return undefined;
    }
  }

  async saveClientInformation(clientInformation: OAuthClientInformation) {
    // Save to session storage during OAuth flow
    const key = getServerSpecificKey(
      SESSION_KEYS.CLIENT_INFORMATION,
      this.serverUrl,
    );
    sessionStorage.setItem(key, JSON.stringify(clientInformation));

    // If server exists, also save to database
    if (await this.serverExists()) {
      try {
        await vanillaTrpcClient.frontend.oauth.upsert.mutate({
          mcp_server_uuid: this.mcpServerUuid,
          client_information: clientInformation,
        });
      } catch (error) {
        console.error("Error saving client information to database:", error);
      }
    }
  }

  async tokens() {
    try {
      // Check if server exists in the database
      const exists = await this.serverExists();

      if (exists) {
        // Get from database if server exists
        const result = await vanillaTrpcClient.frontend.oauth.get.query({
          mcp_server_uuid: this.mcpServerUuid,
        });
        if (result.success && result.data?.tokens) {
          return await OAuthTokensSchema.parseAsync(result.data.tokens);
        }
      } else {
        // Get from session storage during OAuth flow
        const key = getServerSpecificKey(SESSION_KEYS.TOKENS, this.serverUrl);
        const storedTokens = sessionStorage.getItem(key);
        if (storedTokens) {
          return await OAuthTokensSchema.parseAsync(JSON.parse(storedTokens));
        }
      }

      return undefined;
    } catch (error) {
      console.error("Error retrieving tokens:", error);
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens) {
    // Save to session storage during OAuth flow
    const key = getServerSpecificKey(SESSION_KEYS.TOKENS, this.serverUrl);
    sessionStorage.setItem(key, JSON.stringify(tokens));

    // If server exists, also save to database
    if (await this.serverExists()) {
      try {
        await vanillaTrpcClient.frontend.oauth.upsert.mutate({
          mcp_server_uuid: this.mcpServerUuid,
          tokens,
        });
      } catch (error) {
        console.error("Error saving tokens to database:", error);
      }
    }
  }

  redirectToAuthorization(authorizationUrl: URL) {
    // Slack v2 OAuth uses `user_scope` for user tokens (which Slack MCP
    // uses) and `scope` for bot tokens. The standard MCP SDK sets `scope`.
    // If this is Slack, copy `scope` into `user_scope` and delete `scope`
    // so Slack validates user permissions instead of failing with
    // "Invalid permissions requested / No scopes requested".
    if (this.serverHostname === "mcp.slack.com") {
      const scope = authorizationUrl.searchParams.get("scope");
      if (scope) {
        authorizationUrl.searchParams.set("user_scope", scope);
        authorizationUrl.searchParams.delete("scope");
      }
    }
    window.location.href = authorizationUrl.href;
  }

  async saveCodeVerifier(codeVerifier: string) {
    // Save to session storage during OAuth flow
    const key = getServerSpecificKey(
      SESSION_KEYS.CODE_VERIFIER,
      this.serverUrl,
    );
    sessionStorage.setItem(key, codeVerifier);

    // If server exists, also save to database
    if (await this.serverExists()) {
      try {
        await vanillaTrpcClient.frontend.oauth.upsert.mutate({
          mcp_server_uuid: this.mcpServerUuid,
          code_verifier: codeVerifier,
        });
      } catch (error) {
        console.error("Error saving code verifier to database:", error);
      }
    }
  }

  async codeVerifier() {
    // Check if server exists in the database
    const exists = await this.serverExists();

    if (exists) {
      // Get from database if server exists
      try {
        const result = await vanillaTrpcClient.frontend.oauth.get.query({
          mcp_server_uuid: this.mcpServerUuid,
        });
        if (result.success && result.data?.code_verifier) {
          return result.data.code_verifier;
        }
      } catch (error) {
        console.error("Error retrieving code verifier from database:", error);
      }
    }

    // Get from session storage during OAuth flow
    const key = getServerSpecificKey(
      SESSION_KEYS.CODE_VERIFIER,
      this.serverUrl,
    );
    const codeVerifier = sessionStorage.getItem(key);
    if (!codeVerifier) {
      throw new Error("No code verifier saved for session");
    }

    return codeVerifier;
  }

  clear() {
    sessionStorage.removeItem(
      getServerSpecificKey(SESSION_KEYS.CLIENT_INFORMATION, this.serverUrl),
    );
    sessionStorage.removeItem(
      getServerSpecificKey(SESSION_KEYS.TOKENS, this.serverUrl),
    );
    sessionStorage.removeItem(
      getServerSpecificKey(SESSION_KEYS.CODE_VERIFIER, this.serverUrl),
    );
  }
}

// Same-origin relay for the SDK `auth()` fetch points (discovery, DCR
// register, token exchange/refresh). The SDK defaults to `fetch` directly
// against the upstream origin, which the document CSP (connect-src 'self')
// blocks. This fetch posts to the backend `/mcp-proxy/server/oauth-fetch`
// route, which validates the target against the registered row's origin
// under the SSRF guard and returns the upstream response. Lookup is by row
// uuid only; no oauth_sessions state required.
export function createProxiedFetch(
  mcpServerUuid: string,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    // Lowercase keys: `new Headers().forEach` always yields lowercase
    // names, so forward them as-is and let the backend merge them into a
    // real Headers instance (case-insensitive) rather than a plain object.
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body != null
          ? String(init.body)
          : undefined;
    const res = await fetch(`/mcp-proxy/server/oauth-fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        mcpServerUuid,
        url: target,
        method: init?.method ?? "GET",
        headers,
        body,
      }),
    });
    const text = await res.text();
    const upstreamHeaders = new Headers();
    const contentType = res.headers.get("content-type");
    if (contentType) upstreamHeaders.set("Content-Type", contentType);
    const wwwAuthenticate = res.headers.get("www-authenticate");
    if (wwwAuthenticate) upstreamHeaders.set("WWW-Authenticate", wwwAuthenticate);
    return new Response(text, { status: res.status, headers: upstreamHeaders });
  };
}

// Factory function to create an OAuth provider for a specific MCP server
export function createAuthProvider(
  mcpServerUuid: string,
  serverUrl: string,
): DbOAuthClientProvider {
  return new DbOAuthClientProvider(mcpServerUuid, serverUrl);
}
