/**
 * What POST /mcp-proxy/server/probe-auth concludes about a remote row.
 *
 * Four fake servers, zero network: `createGuardedFetch` is mocked to return
 * a canned fetch per scenario, so the JSON `kind` below comes from the
 * route's decision logic, not from any socket. Every fetched URL must stay
 * on the row's own origin (the guard's `allowlistOrigin` pin).
 */

import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerInfo, lookupMock, findAllMock, findSessionMock, guardCalls, fetchCalls, fetchImpl } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  lookupMock: vi.fn(),
  findAllMock: vi.fn(),
  findSessionMock: vi.fn(),
  guardCalls: [] as Array<{ allowlistOrigin?: string }>,
  fetchCalls: [] as Array<{ url: string; init?: unknown }>,
  fetchImpl: { current: async (_url: string, _init?: unknown) => ({ ok: false, status: 404, text: async () => "nope" }) },
}));

vi.mock("@/utils/logger", () => ({
  default: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

vi.mock("@/lib/metamcp/url-guard", () => ({
  createGuardedFetch: (options: { allowlistOrigin?: string }) => {
    guardCalls.push(options);
    return (url: string, init?: unknown) => {
      fetchCalls.push({ url: String(url), init });
      return fetchImpl.current(String(url), init);
    };
  },
}));

vi.mock("../../db/repositories", () => ({
  mcpServersRepository: { findAllAccessibleToUser: findAllMock },
  oauthSessionsRepository: { findByMcpServerUuid: findSessionMock },
  namespaceMappingsRepository: { findNamespacesByServerUuid: vi.fn(async () => []) },
}));

vi.mock("../../db/index", () => ({ db: {}, pool: {} }));
vi.mock("../../lib/mcp-proxy", () => ({ default: vi.fn() }));
vi.mock("../../lib/metamcp/metamcp-server-pool", () => ({ metaMcpServerPool: {} }));
vi.mock("../../lib/metamcp/mcp-server-pool", () => ({ mcpServerPool: {} }));
vi.mock("../../lib/metamcp/client", () => ({ transformDockerUrl: (url: string) => url }));
vi.mock("../../lib/stdio-transport/process-managed-transport", () => ({
  ProcessManagedStdioTransport: class {},
}));

// Dynamic import: mocks above must register before the route module loads.
const { default: serverRouter } = await import("./server");

const PUBLIC_V4 = "93.184.216.34";
const CALLER_ID = "user-caller";

interface AuthedRequest extends express.Request {
  user?: { id: string };
}

const rowByUuid: Record<string, { uuid: string; name: string; type: string; url: string }> = {
  "11111111-1111-4111-8111-111111111111": { uuid: "11111111-1111-4111-8111-111111111111", name: "fake-open", type: "STREAMABLE_HTTP", url: "https://fake-open.example.com/mcp" },
  "22222222-2222-4222-8222-222222222222": { uuid: "22222222-2222-4222-8222-222222222222", name: "fake-dcr", type: "STREAMABLE_HTTP", url: "https://fake-dcr.example.com/mcp" },
  "33333333-3333-4333-8333-333333333333": { uuid: "33333333-3333-4333-8333-333333333333", name: "fake-static", type: "STREAMABLE_HTTP", url: "https://fake-static.example.com/mcp" },
  "44444444-4444-4444-8444-444444444444": { uuid: "44444444-4444-4444-8444-444444444444", name: "fake-apikey", type: "STREAMABLE_HTTP", url: "https://fake-apikey.example.com/mcp" },
};

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const notFound = () => ({ ok: false, status: 404, text: async () => "nope" });

/** Canned upstream: metadata answers per scenario, anything else is the initialize probe. */
function serveScenario(meta: Record<string, unknown> | null, initStatus: number, initBody: unknown = {}) {
  fetchImpl.current = async (url: string) =>
    url.includes(".well-known") ? (meta ? json(200, meta) : notFound()) : json(initStatus, initBody);
}

let baseUrl = "";

async function probe(mcpServerUuid: string): Promise<{ status: number; body: { kind?: string } }> {
  const res = await fetch(`${baseUrl}/probe-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mcpServerUuid }),
  });
  return { status: res.status, body: (await res.json()) as { kind?: string } };
}

/** Every URL the route fetched stays on the row's origin; guard pinned to it. */
function expectOriginPin(rowUrl: string) {
  const origin = new URL(rowUrl).origin;
  expect(guardCalls.at(-1)).toMatchObject({ allowlistOrigin: origin });
  expect(fetchCalls.length).toBeGreaterThan(0);
  for (const { url } of fetchCalls) expect(new URL(url).origin).toBe(origin);
}

let server: Server;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    // Express req carries the session user in production; mirror that here.
    const authed = req as AuthedRequest;
    authed.user = { id: CALLER_ID };
    next();
  });
  app.use("/", serverRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  vi.clearAllMocks();
  guardCalls.length = 0;
  fetchCalls.length = 0;
  lookupMock.mockResolvedValue([{ address: PUBLIC_V4 }]);
  findAllMock.mockResolvedValue(Object.values(rowByUuid));
  findSessionMock.mockResolvedValue(null);
});

describe("POST /mcp-proxy/server/probe-auth", () => {
  it("fake-open: metadata 404 + anonymous initialize 200 → open", async () => {
    const row = rowByUuid["11111111-1111-4111-8111-111111111111"];
    serveScenario(null, 200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    const { status, body } = await probe(row.uuid);
    expect(status).toBe(200);
    expect(body.kind).toBe("open");
    expectOriginPin(row.url);
  });

  it("fake-dcr: registration_endpoint present, no stored session → dcr", async () => {
    const row = rowByUuid["22222222-2222-4222-8222-222222222222"];
    serveScenario(
      { registration_endpoint: "https://auth.example.com/register", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token" },
      401,
    );
    const { status, body } = await probe(row.uuid);
    expect(status).toBe(200);
    expect(body.kind).toBe("dcr");
    expectOriginPin(row.url);
  });

  it("fake-static: auth endpoints without registration_endpoint, no stored session → static-required", async () => {
    const row = rowByUuid["33333333-3333-4333-8333-333333333333"];
    serveScenario(
      { authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token" },
      401,
    );
    const { status, body } = await probe(row.uuid);
    expect(status).toBe(200);
    expect(body.kind).toBe("static-required");
    expectOriginPin(row.url);
  });

  it("fake-apikey: metadata 404 + initialize 401 → unknown", async () => {
    const row = rowByUuid["44444444-4444-4444-8444-444444444444"];
    serveScenario(null, 401, { error: "unauthorized" });
    const { status, body } = await probe(row.uuid);
    expect(status).toBe(200);
    expect(body.kind).toBe("unknown");
    expectOriginPin(row.url);
  });

  it("cross-user uuid returns generic 404 and fetches nothing", async () => {
    // findAllAccessibleToUser returns only the caller's rows; a uuid
    // belonging to another user resolves to nothing and must answer the
    // same generic 404 as a nonexistent uuid (no existence oracle), with
    // zero outbound fetches.
    findAllMock.mockResolvedValue([
      rowByUuid["11111111-1111-4111-8111-111111111111"],
    ]);
    const { status } = await probe("22222222-2222-4222-8222-222222222222");
    expect(status).toBe(404);
    expect(fetchCalls.length).toBe(0);
  });
});
