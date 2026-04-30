import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { requestIdMiddleware } from "../../src/middleware/request-id.js";
import { loggerMiddleware } from "../../src/middleware/logger.js";
import { authInternalMiddleware } from "../../src/middleware/auth-internal.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { handleMintRequest } from "../../src/internal/mint.js";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { encryptField } from "../../src/lib/crypto.js";
import { hmacSha256Hex } from "../../src/lib/hmac.js";
import type { Env, MerchantRecord } from "../../src/types.js";

// Test-only env — matches vitest.config.ts bindings
const TEST_STORE_ID = "store-integration-test";
const TEST_SCOPES = ["orders.read_write", "products.read_write"];
const INTERNAL_SECRET = "test-internal-secret";

function makeKvNamespace(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, caret: undefined }),
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
    }),
  } as unknown as KVNamespace;
}

function buildEnv(tokensKv: KVNamespace, denylistKv: KVNamespace): Env {
  return {
    SALLA_TOKENS: tokensKv,
    JWT_DENYLIST: denylistKv,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-signing-secret-for-unit-tests",
    SALLA_WEBHOOK_SECRET_V1: "test-webhook-secret",
    INTERNAL_API_SECRET_V1: INTERNAL_SECRET,
    SALLA_CLIENT_ID: "test-client-id",
    SALLA_CLIENT_SECRET: "test-client-secret",
    MCP_ISSUER: "https://mcp.salla.dev",
    MCP_AUDIENCE: "salla-merchant-mcp",
    REFRESH_WINDOW_SECONDS: "3600",
    MAX_INSTALL_URL_LIFETIME_SECONDS: "7776000",
  };
}

function buildApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => {
    Object.assign(c.env, env);
    return next();
  });
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);
  app.post("/internal/mint", authInternalMiddleware, handleMintRequest);
  app.all("/v1/mcp", authMiddleware, handleMcpRequest);
  return app;
}

async function buildMintHeaders(body: string, secret: string): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return {
    "Content-Type": "application/json",
    "X-Salla-Internal-Auth": hmac,
    "X-Salla-Internal-Timestamp": String(timestamp),
  };
}

async function seedMerchantRecord(env: Env): Promise<void> {
  const [accessEnc, refreshEnc] = await Promise.all([
    encryptField("salla-access-token-value", env, TEST_STORE_ID, 1),
    encryptField("salla-refresh-token-value", env, TEST_STORE_ID, 1),
  ]);
  const record: MerchantRecord = {
    store_id: TEST_STORE_ID,
    scopes: TEST_SCOPES,
    access_token_ct: accessEnc.ct,
    access_token_iv: accessEnc.iv,
    refresh_token_ct: refreshEnc.ct,
    refresh_token_iv: refreshEnc.iv,
    access_expires_at: Date.now() + 3_600_000,
    refresh_expires_at: Date.now() + 30 * 24 * 3_600_000,
    active_jti: null,
    installed_at: Date.now(),
    updated_at: Date.now(),
    key_version: 1,
    status: "active",
    schema_version: 1,
  };
  await env.SALLA_TOKENS.put(`store:${TEST_STORE_ID}`, JSON.stringify(record));
}

async function mintInstallUrl(app: Hono<{ Bindings: Env }>, env: Env, scopes: string[]): Promise<{ install_url: string; jti: string }> {
  const body = JSON.stringify({ store_id: TEST_STORE_ID, scopes });
  const headers = await buildMintHeaders(body, INTERNAL_SECRET);
  const res = await app.request(
    new Request("http://localhost/internal/mint", { method: "POST", headers, body }),
    {},
    env,
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ install_url: string; jti: string }>;
}

function extractToken(installUrl: string): string {
  const url = new URL(installUrl);
  const token = url.searchParams.get("token");
  if (!token) throw new Error("No token in install_url");
  return token;
}

async function mcpRequest(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  token: string,
  rpcBody: unknown,
): Promise<Response> {
  return app.request(
    new Request("http://localhost/v1/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // MCP Streamable HTTP requires the client to advertise JSON acceptance
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(rpcBody),
    }),
    {},
    env,
  );
}

describe("MCP tools integration", () => {
  let tokensKv: KVNamespace;
  let denylistKv: KVNamespace;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    tokensKv = makeKvNamespace();
    denylistKv = makeKvNamespace();
    env = buildEnv(tokensKv, denylistKv);
    app = buildApp(env);
    await seedMerchantRecord(env);
  });

  it("tools/list returns tools matching minted scopes intersected with merchant scopes", async () => {
    // Mint with only orders.read_write scope (subset of merchant's scopes)
    const { install_url } = await mintInstallUrl(app, env, ["orders.read_write"]);
    const token = extractToken(install_url);

    const res = await mcpRequest(app, env, token, {
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 1,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { tools: Array<{ name: string }> } };
    const tools = body.result?.tools ?? [];
    const names = tools.map((t) => t.name);

    // whoami is always present (no required scopes)
    expect(names).toContain("whoami");
    // orders.read_write tools are present (scope intersection allows them)
    expect(names).toContain("list_orders");
    expect(names).toContain("get_order");
    // products scope was not minted → catalog/inventory tools absent
    expect(names).not.toContain("search_catalog");
    expect(names).not.toContain("get_inventory_levels");
  });

  it("tools/call whoami returns correct store_id, jti, and effective_scopes", async () => {
    const { install_url, jti } = await mintInstallUrl(app, env, TEST_SCOPES);
    const token = extractToken(install_url);

    const res = await mcpRequest(app, env, token, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
      id: 2,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      result?: { content: Array<{ type: string; text: string }> };
    };
    const content = body.result?.content ?? [];
    // Second content block is the JSON summary
    const structuredText = content[1]?.text ?? "";
    const structured = JSON.parse(structuredText) as {
      store_id: string;
      jti: string;
      effective_scopes: string[];
    };

    expect(structured.store_id).toBe(TEST_STORE_ID);
    expect(structured.jti).toBe(jti);
    // effectiveScopes = JWT scopes ∩ merchant scopes = TEST_SCOPES (identical here)
    expect(structured.effective_scopes).toEqual(expect.arrayContaining(TEST_SCOPES));
    expect(structured.effective_scopes).toHaveLength(TEST_SCOPES.length);
  });

  it("scope ceiling: minted scopes ⊂ merchant scopes → effective scopes are intersected", async () => {
    // Mint with only shipments.read — but merchant doesn't have that scope
    // Actually TEST_SCOPES = ["orders.read_write", "products.read_write"] so we mint with just orders
    const { install_url } = await mintInstallUrl(app, env, ["orders.read_write"]);
    const token = extractToken(install_url);

    const res = await mcpRequest(app, env, token, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
      id: 3,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      result?: { content: Array<{ type: string; text: string }> };
    };
    const structured = JSON.parse(body.result?.content[1]?.text ?? "{}") as {
      effective_scopes: string[];
    };
    // Only orders scope should appear despite merchant having products too
    expect(structured.effective_scopes).toEqual(["orders.read_write"]);
  });

  it("tools/call for out-of-scope tool → HTTP 403 insufficient_scope", async () => {
    // Mint with only orders scope — no products scope
    const { install_url } = await mintInstallUrl(app, env, ["orders.read_write"]);
    const token = extractToken(install_url);

    const res = await mcpRequest(app, env, token, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "search_catalog", arguments: { query: "shoes" } },
      id: 4,
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("insufficient_scope");
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAuth).toContain("insufficient_scope");
  });
});
