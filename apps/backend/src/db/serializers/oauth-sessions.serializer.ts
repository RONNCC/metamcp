import {
  OAuthClientInformation,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

type DatabaseOAuthSession = {
  uuid: string;
  mcp_server_uuid: string;
  client_information: OAuthClientInformation | null;
  tokens: OAuthTokens | null;
  code_verifier: string | null;
  created_at: Date;
  updated_at: Date;
};

type SerializedOAuthSession = {
  uuid: string;
  mcp_server_uuid: string;
  client_information: OAuthClientInformation | null;
  tokens: OAuthTokens | null;
  code_verifier: string | null;
  created_at: string;
  updated_at: string;
};

export class OAuthSessionsSerializer {
  static serializeOAuthSession(
    dbSession: DatabaseOAuthSession,
  ): SerializedOAuthSession {
    // jsonb columns come back null/undefined/{} when nothing was stored
    // (e.g. a row recreated with no credentials). `{}` is neither null nor
    // undefined so `??` alone misses it, yet it still fails the Zod output
    // schema (`client_id` required). Normalize all three to null.
    const isEmptyObject = (value: unknown): boolean =>
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 0;
    const clientInfo = isEmptyObject(dbSession.client_information)
      ? null
      : (dbSession.client_information ?? null);
    return {
      uuid: dbSession.uuid,
      mcp_server_uuid: dbSession.mcp_server_uuid,
      client_information: clientInfo,
      tokens: (dbSession.tokens as OAuthTokens | null | undefined) ?? null,
      code_verifier: dbSession.code_verifier ?? null,
      created_at: dbSession.created_at.toISOString(),
      updated_at: dbSession.updated_at.toISOString(),
    };
  }
}
