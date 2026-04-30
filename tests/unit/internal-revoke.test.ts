import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { requestIdMiddleware } from "../../src/middleware/request-id.js";
import { loggerMiddleware } from "../../src/middleware/logger.js";
import { authInternalMiddleware } from "../../src/middleware/auth-internal.js";
import { handleRevokeRequest } from "../../src/internal/revoke.js";
import { hmacSha256Hex, sha256Hex } from "../../src/lib/hmac.js";
import { encryptField } from "../../src/lib/crypto.js";
import type { Env, MerchantRecord, RevokedJTI } from "../../src/types.js";

// ── KV mock ───────────────────────────────────────────────────────────────────

function makeKvNamespace(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, caret: undefined }),
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

// ── Env builder ───────────────────────────────────────────────────────────────

const INTERNAL_SECRET = "test-internal-secret-v1";
const STORE_ID = "77001";
const ACTIVE_JTI = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function buildEnv(
  tokensKv: KVNamespace,
  denylistKv: KVNamespace,
): Env {
  return {
    SALLA_TOKENS: tokensKv,
    JWT_DENYLIST: denylistKv,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-secret",
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

async function buildRecord(env: Env, storeId: string, activeJti: string | null): Promise<MerchantRecord> {
  const keyVersion = 1;
  const accessEnc = await encryptField("access-token-value", env, storeId, keyVersion);
  const refreshEnc = await encryptField("refresh-token-value", env, storeId, keyVersion);
  return {
    store_id: storeId,
    scopes: ["orders.read_write"],
    access_token_ct: accessEnc.ct,
    access_token_iv: accessEnc.iv,
    refresh_token_ct: refreshEnc.ct,
    refresh_token_iv: refreshEnc.iv,
    access_expires_at: Date.now() + 14 * 24 * 3600 * 1000,
    refresh_expires_at: Date.now() + 30 * 24 * 3600 * 1000,
    active_jti: activeJti,
    installed_at: Date.now(),
    updated_at: Date.now(),
    key_version: keyVersion,
    status: "active",
    schema_version: 1,
  };
}

function buildApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => { Object.assign(c.env, env); return next(); });
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);
  app.post("/internal/revoke", authInternalMiddleware, handleRevokeRequest);
  return app;
}

async function revokeRequest(body: string, secret: string): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `${timestamp}.${body}`;
  const hmac = await hmacSha256Hex(secret, message);
  return new Request("http://localhost/internal/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Salla-Internal-Auth": hmac,
      "X-Salla-Internal-Timestamp": String(timestamp),
    },
    body,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("internal revoke endpoint", () => {
  let tokensKv: KVNamespace & { _store: Map<string, string> };
  let denylistKv: KVNamespace & { _store: Map<string, string> };
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    tokensKv = makeKvNamespace() as KVNamespace & { _store: Map<string, string> };
    denylistKv = makeKvNamespace() as KVNamespace & { _store: Map<string, string> };
    env = buildEnv(tokensKv, denylistKv);
    app = buildApp(env);

    // Seed a merchant record with an active JTI
    const record = await buildRecord(env, STORE_ID, ACTIVE_JTI);
    tokensKv._store.set(`store:${STORE_ID}`, JSON.stringify(record));
  });

  it("revoking the active JTI returns {revoked:true} and writes denylist entry", async () => {
    const body = JSON.stringify({ store_id: STORE_ID, jti: ACTIVE_JTI });
    const res = await app.request(await revokeRequest(body, INTERNAL_SECRET), {}, env);

    expect(res.status).toBe(200);
    const json = await res.json() as { revoked: boolean; reason: string };
    expect(json.revoked).toBe(true);
    expect(json.reason).toBe("revoked");

    // Denylist must contain the hash
    const jtiHash = await sha256Hex(ACTIVE_JTI);
    const denylistRaw = denylistKv._store.get(`jti:${jtiHash}`);
    expect(denylistRaw).toBeTruthy();
    const entry = JSON.parse(denylistRaw!) as RevokedJTI;
    expect(entry.reason).toBe("manual");
    expect(entry.store_id).toBe(STORE_ID);

    // active_jti must be cleared
    const recordRaw = tokensKv._store.get(`store:${STORE_ID}`);
    const record = JSON.parse(recordRaw!) as MerchantRecord;
    expect(record.active_jti).toBeNull();
  });

  it("revoking a non-active JTI returns {revoked:false, reason:'already_revoked'} and still writes denylist", async () => {
    const otherJti = "11111111-2222-3333-4444-555555555555";
    const body = JSON.stringify({ store_id: STORE_ID, jti: otherJti });
    const res = await app.request(await revokeRequest(body, INTERNAL_SECRET), {}, env);

    expect(res.status).toBe(200);
    const json = await res.json() as { revoked: boolean; reason: string };
    expect(json.revoked).toBe(false);
    expect(json.reason).toBe("already_revoked");

    // Denylist entry still written (belt-and-braces)
    const jtiHash = await sha256Hex(otherJti);
    expect(denylistKv._store.has(`jti:${jtiHash}`)).toBe(true);

    // active_jti is preserved (was ACTIVE_JTI, not the one we revoked)
    const record = JSON.parse(tokensKv._store.get(`store:${STORE_ID}`)!) as MerchantRecord;
    expect(record.active_jti).toBe(ACTIVE_JTI);
  });

  it("revoking a JTI for an unknown store returns 404", async () => {
    const body = JSON.stringify({ store_id: "nonexistent-store", jti: ACTIVE_JTI });
    const res = await app.request(await revokeRequest(body, INTERNAL_SECRET), {}, env);
    expect(res.status).toBe(404);
  });

  it("invalid HMAC returns 401 without touching KV", async () => {
    const body = JSON.stringify({ store_id: STORE_ID, jti: ACTIVE_JTI });
    const timestamp = Math.floor(Date.now() / 1000);
    const req = new Request("http://localhost/internal/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Salla-Internal-Auth": "deadbeef00000000",
        "X-Salla-Internal-Timestamp": String(timestamp),
      },
      body,
    });
    const res = await app.request(req, {}, env);
    expect(res.status).toBe(401);

    // KV untouched
    const jtiHash = await sha256Hex(ACTIVE_JTI);
    expect(denylistKv._store.has(`jti:${jtiHash}`)).toBe(false);
  });
});
