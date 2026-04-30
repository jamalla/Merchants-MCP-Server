import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { requestIdMiddleware } from "../../src/middleware/request-id.js";
import { loggerMiddleware } from "../../src/middleware/logger.js";
import { authInternalMiddleware } from "../../src/middleware/auth-internal.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { handleMintRequest } from "../../src/internal/mint.js";
import { handleRevokeRequest } from "../../src/internal/revoke.js";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { encryptField } from "../../src/lib/crypto.js";
import { hmacSha256Hex, sha256Hex } from "../../src/lib/hmac.js";
import { decryptField } from "../../src/lib/crypto.js";
import type { Env, MerchantRecord } from "../../src/types.js";

// ── KV mock ───────────────────────────────────────────────────────────────────

function makeKvNamespace(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, _opts?: unknown) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, caret: undefined }),
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORE_ID = "revoke-integration-store";
const INTERNAL_SECRET = "test-internal-secret";
const SCOPES = ["orders.read_write"];

// ── Env builder ───────────────────────────────────────────────────────────────

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

async function seedMerchantRecord(env: Env): Promise<void> {
  const [accessEnc, refreshEnc] = await Promise.all([
    encryptField("salla-access-token-value", env, STORE_ID, 1),
    encryptField("salla-refresh-token-value", env, STORE_ID, 1),
  ]);
  const record: MerchantRecord = {
    store_id: STORE_ID,
    scopes: SCOPES,
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
  await env.SALLA_TOKENS.put(`store:${STORE_ID}`, JSON.stringify(record));
}

// ── App ───────────────────────────────────────────────────────────────────────

function buildApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => { Object.assign(c.env, env); return next(); });
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);
  app.post("/internal/mint", authInternalMiddleware, handleMintRequest);
  app.post("/internal/revoke", authInternalMiddleware, handleRevokeRequest);
  app.all("/v1/mcp", authMiddleware, handleMcpRequest);
  return app;
}

// ── Request helpers ───────────────────────────────────────────────────────────

async function buildInternalHeaders(body: string, secret: string): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return {
    "Content-Type": "application/json",
    "X-Salla-Internal-Auth": hmac,
    "X-Salla-Internal-Timestamp": String(timestamp),
  };
}

async function mintInstallUrl(
  app: Hono<{ Bindings: Env }>,
  env: Env,
): Promise<{ install_url: string; jti: string }> {
  const body = JSON.stringify({ store_id: STORE_ID, scopes: SCOPES });
  const headers = await buildInternalHeaders(body, INTERNAL_SECRET);
  const res = await app.request(
    new Request("http://localhost/internal/mint", { method: "POST", headers, body }),
    {},
    env,
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ install_url: string; jti: string }>;
}

async function revokeJti(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  jti: string,
): Promise<Response> {
  const body = JSON.stringify({ store_id: STORE_ID, jti });
  const headers = await buildInternalHeaders(body, INTERNAL_SECRET);
  return app.request(
    new Request("http://localhost/internal/revoke", { method: "POST", headers, body }),
    {},
    env,
  );
}

function extractToken(installUrl: string): string {
  const url = new URL(installUrl);
  const token = url.searchParams.get("token");
  if (!token) throw new Error("No token in install_url");
  return token;
}

async function mcpPing(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  token: string,
): Promise<Response> {
  return app.request(
    new Request("http://localhost/v1/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 }),
    }),
    {},
    env,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("mint-revoke integration", () => {
  let tokensKv: KVNamespace & { _store: Map<string, string> };
  let denylistKv: KVNamespace & { _store: Map<string, string> };
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    tokensKv = makeKvNamespace() as KVNamespace & { _store: Map<string, string> };
    denylistKv = makeKvNamespace() as KVNamespace & { _store: Map<string, string> };
    env = buildEnv(tokensKv, denylistKv);
    app = buildApp(env);
    await seedMerchantRecord(env);
  });

  it("minting a second URL auto-revokes the first; first URL returns 401, second returns 200", async () => {
    const { install_url: urlA, jti: jtiA } = await mintInstallUrl(app, env);
    const tokenA = extractToken(urlA);

    // Before second mint, first URL works
    const resBefore = await mcpPing(app, env, tokenA);
    expect(resBefore.status).toBe(200);

    // Mint second URL — should atomically revoke first JTI
    const { install_url: urlB } = await mintInstallUrl(app, env);
    const tokenB = extractToken(urlB);

    // Old URL is denied
    const resA = await mcpPing(app, env, tokenA);
    expect(resA.status).toBe(401);

    // New URL works
    const resB = await mcpPing(app, env, tokenB);
    expect(resB.status).toBe(200);

    // jtiA hash in denylist
    const jtiAHash = await sha256Hex(jtiA);
    expect(denylistKv._store.has(`jti:${jtiAHash}`)).toBe(true);
  });

  it("explicit revoke → URL returns 401", async () => {
    const { install_url, jti } = await mintInstallUrl(app, env);
    const token = extractToken(install_url);

    // Confirm it works before revoke
    const resBefore = await mcpPing(app, env, token);
    expect(resBefore.status).toBe(200);

    const revokeRes = await revokeJti(app, env, jti);
    expect(revokeRes.status).toBe(200);
    const revokeJson = await revokeRes.json() as { revoked: boolean };
    expect(revokeJson.revoked).toBe(true);

    // Now 401
    const resAfter = await mcpPing(app, env, token);
    expect(resAfter.status).toBe(401);
  });

  it("revoking the same JTI twice returns already_revoked on the second call", async () => {
    const { jti } = await mintInstallUrl(app, env);

    const res1 = await revokeJti(app, env, jti);
    expect(res1.status).toBe(200);
    expect(((await res1.json()) as { revoked: boolean }).revoked).toBe(true);

    const res2 = await revokeJti(app, env, jti);
    expect(res2.status).toBe(200);
    const json2 = await res2.json() as { revoked: boolean; reason: string };
    expect(json2.revoked).toBe(false);
    expect(json2.reason).toBe("already_revoked");
  });

  it("revocation does not touch the merchant's Salla tokens", async () => {
    const { jti } = await mintInstallUrl(app, env);

    // Record the encrypted tokens before revoke
    const recordBefore = JSON.parse(tokensKv._store.get(`store:${STORE_ID}`)!) as MerchantRecord;
    const accessCtBefore = recordBefore.access_token_ct;

    await revokeJti(app, env, jti);

    // Tokens must be unchanged (same ciphertext)
    const recordAfter = JSON.parse(tokensKv._store.get(`store:${STORE_ID}`)!) as MerchantRecord;
    expect(recordAfter.access_token_ct).toBe(accessCtBefore);

    // And still decrypt to the original values
    const decrypted = await decryptField(
      recordAfter.access_token_ct,
      recordAfter.access_token_iv,
      env,
      STORE_ID,
      recordAfter.key_version,
    );
    expect(decrypted).toBe("salla-access-token-value");
  });
});
