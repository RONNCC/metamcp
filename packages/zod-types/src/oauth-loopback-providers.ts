// Registry of upstream OAuth providers that have no dynamic client
// registration: their redirect_uri allowlist is a fixed set an admin
// configures by hand with the provider, exact-string-matched (RFC 6749
// §3.1.2). MetaMCP's default OAuth callback for every DCR-capable connector
// is `${APP_URL}/fe-oauth/callback`, a page served at whatever origin this
// deployment happens to be reachable on — a value the provider's admin has
// no way to pre-register.
//
// Claude Code and VS Code solve this the same way every native OAuth client
// does (RFC 8252 §7.3): a throwaway loopback listener on a fixed port,
// registered with the provider once. Every entry here gets the same fixed
// loopback port/path; the frontend (lib/oauth-provider.ts) uses it as the
// `redirect_uri` for a matching server, and the backend
// (lib/oauth-loopback-forwarder.ts) runs the listener that catches the
// provider's redirect there and forwards it to the real `/fe-oauth/callback`
// page with the code/state intact.
//
// Add an entry here when a new provider needs this; both sides pick it up
// automatically.
export interface OAuthLoopbackProvider {
  /** Upstream server hostname this override applies to (e.g. "mcp.slack.com"). */
  hostname: string;
  /** Fixed loopback port to register with the upstream provider. */
  port: number;
  /** Path the upstream provider redirects to on this port. */
  callbackPath: string;
  /**
   * Space-separated OAuth scopes to request. Providers without dynamic
   * client registration commonly also skip PRM `scopes_supported`
   * discovery through the SDK's proxied fetch, which otherwise leaves the
   * SDK's scope-selection fallback chain empty and the authorization
   * request scope-less (some providers, e.g. Slack, reject that outright).
   */
  scope: string;
}

export const OAUTH_LOOPBACK_PROVIDERS: readonly OAuthLoopbackProvider[] = [
  // Already whitelisted on this Slack app for Claude Code/VS Code's own
  // loopback OAuth flows (~/.claude.json's slack-ds entry uses the same
  // port), so no new provider-side whitelist request is needed. Scope list
  // from https://mcp.slack.com/.well-known/oauth-protected-resource's
  // scopes_supported.
  {
    hostname: "mcp.slack.com",
    port: 3881,
    callbackPath: "/callback",
    scope:
      "identify channels:history groups:history im:history mpim:history channels:read emoji:read files:read canvases:read groups:read mpim:read reactions:read users:read users:read.email channels:write chat:write canvases:write groups:write im:write mpim:write reactions:write search:read.public search:read.private search:read.mpim search:read.im search:read.files search:read.users",
  },
];

export function loopbackRedirectUriFor(hostname: string): string | undefined {
  const provider = OAUTH_LOOPBACK_PROVIDERS.find(
    (p) => p.hostname === hostname,
  );
  return provider
    ? `http://localhost:${provider.port}${provider.callbackPath}`
    : undefined;
}

export function loopbackScopeFor(hostname: string): string | undefined {
  return OAUTH_LOOPBACK_PROVIDERS.find((p) => p.hostname === hostname)?.scope;
}
