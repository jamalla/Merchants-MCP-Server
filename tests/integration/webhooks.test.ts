import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { requestIdMiddleware } from "../../src/middleware/request-id.js";
import { loggerMiddleware } from "../../src/middleware/logger.js";
import { authInternalMiddleware } from "../../src/middleware/auth-internal.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { handleSallaWebhook } from "../../src/webhooks/salla.js";
import { handleMintRequest } from "../../src/internal/mint.js";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { decryptField, encryptField } from "../../src/lib/crypto.js";
import { hmacSha256Hex } from "../../src/lib/hmac.js";
import type { Env, MerchantRecord } from "../../src/types.js";

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

const WEBHOOK_SECRET = "integration-webhook-secret";

function buildEnv(tokensKv: KVNamespace): Env {
  return {
    SALLA_TOKENS: tokensKv,
    JWT_DENYLIST: makeKvNamespace(),
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-secret",
    SALLA_WEBHOOK_SECRET_V1: WEBHOOK_SECRET,
    INTERNAL_API_SECRET_V1: "test-internal-secret",
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
  app.use("*", (c, next) => { Object.assign(c.env, env); return next(); });
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);
  app.post("/webhooks/salla", handleSallaWebhook);
  return app;
}

// ── Request builders ──────────────────────────────────────────────────────────

async function signedRequest(body: string, secret = WEBHOOK_SECRET): Promise<Request> {
  const sig = await hmacSha256Hex(secret, new TextEncoder().encode(body).buffer as ArrayBuffer);
  return new Request("http://localhost/webhooks/salla", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salla-Signature": sig },
    body,
  });
}

function authorizeBody(storeId: number, expiresUnixSec: number, scope = "orders.read_write products.read_write"): string {
  return JSON.stringify({
    event: "app.store.authorize",
    merchant: storeId,
    data: {
      access_token: `access-${storeId}`,
      refresh_token: `refresh-${storeId}`,
      expires: expiresUnixSec,
      scope,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const STORE_ID = 55001;
const FUTURE_EXPIRES = Math.floor(Date.now() / 1000) + 14 * 24 * 3600; // ~14 days from now

describe("webhook integration: app.store.authorize", () => {
  let tokensKv: KVNamespace & { _store: Map<string, string> };
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    tokensKv = makeKvNamespace() as KVNamespace & { _store: Map<string, string> };
    env = buildEnv(tokensKv);
    app = buildApp(env);
  });

  it("signed webhook stores a decryptable MerchantRecord in KV", async () => {
    const body = authorizeBody(STORE_ID, FUTURE_EXPIRES);
    const res = await app.request(await signedRequest(body), {}, env);

    expect(res.status).toBe(200);
    const json = await res.json() as { outcome: string };
    expect(json.outcome).toBe("stored");

    const raw = tokensKv._store.get(`store:${STORE_ID}`);
    expect(raw).toBeTruthy();
    const record = JSON.parse(raw!) as MerchantRecord;

    expect(record.store_id).toBe(String(STORE_ID));
    expect(record.scopes).toEqual(["orders.read_write", "products.read_write"]);
    expect(record.status).toBe("active");
    expect(record.key_version).toBe(1);
    expect(record.schema_version).toBe(1);
    // expires: absolute Unix ts → ms conversion
    expect(record.access_expires_at).toBe(FUTURE_EXPIRES * 1000);
    // Tokens must be encrypted (not plaintext)
    expect(record.access_token_ct).not.toBe(`access-${STORE_ID}`);

    // Decrypt and verify the stored tokens are correct
    const decrypted = await decryptField(
      record.access_token_ct,
      record.access_token_iv,
      env,
      String(STORE_ID),
      1,
    );
    expect(decrypted).toBe(`access-${STORE_ID}`);
  });

  it("replaying the identical webhook returns 200 and leaves KV state unchanged", async () => {
    const body = authorizeBody(STORE_ID, FUTURE_EXPIRES);

    // First delivery
    const res1 = await app.request(await signedRequest(body), {}, env);
    expect(res1.status).toBe(200);
    const raw1 = tokensKv._store.get(`store:${STORE_ID}`)!;

    // Replay — same body, same expires
    const res2 = await app.request(await signedRequest(body), {}, env);
    expect(res2.status).toBe(200);
    const raw2 = tokensKv._store.get(`store:${STORE_ID}`)!;

    // KV value may update (installed_at preserved) but core fields identical
    const rec1 = JSON.parse(raw1) as MerchantRecord;
    const rec2 = JSON.parse(raw2) as MerchantRecord;
    expect(rec2.access_expires_at).toBe(rec1.access_expires_at);
    // The second delivery is replay_ignored → KV unchanged
    expect(raw2).toBe(raw1);
  });

  it("older expires than stored record is ignored as replay", async () => {
    const newerExpires = FUTURE_EXPIRES;
    const olderExpires = FUTURE_EXPIRES - 3600; // 1 hour older

    // Establish the "newer" record first
    const bodyNewer = authorizeBody(STORE_ID, newerExpires);
    await app.request(await signedRequest(bodyNewer), {}, env);
    const rawAfterNewer = tokensKv._store.get(`store:${STORE_ID}`)!;

    // Send older event — must be ignored
    const bodyOlder = authorizeBody(STORE_ID, olderExpires);
    const res = await app.request(await signedRequest(bodyOlder), {}, env);
    expect(res.status).toBe(200);
    const json = await res.json() as { outcome: string };
    expect(json.outcome).toBe("replay_ignored");

    // KV must not have changed
    const rawAfterOlder = tokensKv._store.get(`store:${STORE_ID}`)!;
    expect(rawAfterOlder).toBe(rawAfterNewer);
  });

  it("invalid signature returns 403 and leaves KV empty", async () => {
    const body = authorizeBody(STORE_ID, FUTURE_EXPIRES);
    const req = new Request("http://localhost/webhooks/salla", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Salla-Signature": "badhex000" },
      body,
    });
    const res = await app.request(req, {}, env);

    expect(res.status).toBe(403);
    expect(tokensKv._store.has(`store:${STORE_ID}`)).toBe(false);
  });

  it("unknown event name returns 200 with no state change", async () => {
    const body = JSON.stringify({ event: "app.some_future_event", merchant: STORE_ID, data: {} });
    const res = await app.request(await signedRequest(body), {}, env);

    expect(res.status).toBe(200);
    expect(tokensKv._store.has(`store:${STORE_ID}`)).toBe(false);
  });

  it("installed_at is preserved on a second app.store.authorize (token rotation scenario)", async () => {
    const body1 = authorizeBody(STORE_ID, FUTURE_EXPIRES);
    await app.request(await signedRequest(body1), {}, env);
    const rec1 = JSON.parse(tokensKv._store.get(`store:${STORE_ID}`)!) as MerchantRecord;
    const installedAt = rec1.installed_at;

    // Second authorize with a later expires (simulates token rotation)
    const laterExpires = FUTURE_EXPIRES + 14 * 24 * 3600;
    const body2 = authorizeBody(STORE_ID, laterExpires);
    await app.request(await signedRequest(body2), {}, env);
    const rec2 = JSON.parse(tokensKv._store.get(`store:${STORE_ID}`)!) as MerchantRecord;

    expect(rec2.installed_at).toBe(installedAt);
    expect(rec2.access_expires_at).toBe(laterExpires * 1000);
  });
});

describe("webhook integration: app.store.uninstalled", () => {
  let tokensKv: KVNamespace & { _store: Map<string, string> };
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    tokensKv = makeKvNamespace() as KVNamespace & { _store: Map<string, string> };
    env = buildEnv(tokensKv);
    app = buildApp(env);
  });

  it("deletes merchant record on app.store.uninstalled", async () => {
    // Seed a record
    tokensKv._store.set(`store:${STORE_ID}`, JSON.stringify({ store_id: String(STORE_ID) }));

    const body = JSON.stringify({ event: "app.store.uninstalled", merchant: STORE_ID, data: {} });
    const res = await app.request(await signedRequest(body), {}, env);

    expect(res.status).toBe(200);
    expect(tokensKv._store.has(`store:${STORE_ID}`)).toBe(false);
  });

  it("app.uninstalled (alternate event name) also deletes", async () => {
    tokensKv._store.set(`store:${STORE_ID}`, JSON.stringify({ store_id: String(STORE_ID) }));

    const body = JSON.stringify({ event: "app.uninstalled", merchant: STORE_ID, data: {} });
    const res = await app.request(await signedRequest(body), {}, env);

    expect(res.status).toBe(200);
    expect(tokensKv._store.has(`store:${STORE_ID}`)).toBe(false);
  });

  it("uninstall on non-existent store is idempotent (returns 200)", async () => {
    const body = JSON.stringify({ event: "app.store.uninstalled", merchant: STORE_ID, data: {} });
    const res = await app.request(await signedRequest(body), {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as { outcome: string }).outcome).toBe("uninstalled");
  });
});

// ── T046: Uninstall → MCP access revocation flow ─────────────────────────────

const INTERNAL_SECRET_V046 = "integration-webhook-secret";
const STORE_ID_V446 = 55002;

function buildFullApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => { Object.assign(c.env, env); return next(); });
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);
  app.post("/webhooks/salla", handleSallaWebhook);
  app.post("/internal/mint", authInternalMiddleware, handleMintRequest);
  app.all("/v1/mcp", authMiddleware, handleMcpRequest);
  return app;
}

function buildFullEnv(tokensKv: KVNamespace): Env {
  return {
    SALLA_TOKENS: tokensKv,
    JWT_DENYLIST: makeKvNamespace(),
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-signing-secret-for-unit-tests",
    SALLA_WEBHOOK_SECRET_V1: INTERNAL_SECRET_V046,
    INTERNAL_API_SECRET_V1: INTERNAL_SECRET_V046,
    SALLA_CLIENT_ID: "test-client-id",
    SALLA_CLIENT_SECRET: "test-client-secret",
    MCP_ISSUER: "https://mcp.salla.dev",
    MCP_AUDIENCE: "salla-merchant-mcp",
    REFRESH_WINDOW_SECONDS: "3600",
    MAX_INSTALL_URL_LIFETIME_SECONDS: "7776000",
  };
}

async function mintForStore(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  storeId: number,
  scopes: string[],
): Promise<string> {
  const body = JSON.stringify({ store_id: String(storeId), scopes });
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = await hmacSha256Hex(INTERNAL_SECRET_V046, `${timestamp}.${body}`);
  const res = await app.request(
    new Request("http://localhost/internal/mint", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Salla-Internal-Auth": hmac,
        "X-Salla-Internal-Timestamp": String(timestamp),
      },
      body,
    }),
    {},
    env,
  );
  expect(res.status).toBe(200);
  const json = await res.json() as { install_url: string };
  const url = new URL(json.install_url);
  const token = url.searchParams.get("token");
  if (!token) throw new Error("No token in install_url");
  return token;
}

async function mcpToolsList(
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

describe("webhook integration: uninstall → MCP access revocation (T046)", () => {
  let tokensKv: KVNamespace & { _store: Map<string, string> };
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    tokensKv = makeKvNamespace() as KVNamespace & { _store: Map<string, string> };
    env = buildFullEnv(tokensKv);
    app = buildFullApp(env);
  });

  it("authorize → mint → uninstall → tool call returns 401", async () => {
    const futureExpires = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
    const authBody = authorizeBody(STORE_ID_V446, futureExpires, "orders.read_write");
    await app.request(await signedRequest(authBody, INTERNAL_SECRET_V046), {}, env);

    const token = await mintForStore(app, env, STORE_ID_V446, ["orders.read_write"]);

    // Confirm access works before uninstall
    const resBefore = await mcpToolsList(app, env, token);
    expect(resBefore.status).toBe(200);

    // Uninstall
    const uninstallBody = JSON.stringify({ event: "app.store.uninstalled", merchant: STORE_ID_V446, data: {} });
    const uninstallRes = await app.request(await signedRequest(uninstallBody, INTERNAL_SECRET_V046), {}, env);
    expect(uninstallRes.status).toBe(200);
    expect(tokensKv._store.has(`store:${STORE_ID_V446}`)).toBe(false);

    // After uninstall, token no longer grants access
    const resAfter = await mcpToolsList(app, env, token);
    expect(resAfter.status).toBe(401);
  });

  it("replay uninstall on already-deleted record returns 200 with uninstalled outcome", async () => {
    const uninstallBody = JSON.stringify({ event: "app.store.uninstalled", merchant: STORE_ID_V446, data: {} });
    const res = await app.request(await signedRequest(uninstallBody, INTERNAL_SECRET_V046), {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as { outcome: string }).outcome).toBe("uninstalled");
  });

  it("fresh authorize after uninstall → new mint → tool call succeeds", async () => {
    const futureExpires = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;

    // First install
    const authBody1 = authorizeBody(STORE_ID_V446, futureExpires, "orders.read_write");
    await app.request(await signedRequest(authBody1, INTERNAL_SECRET_V046), {}, env);
    const token1 = await mintForStore(app, env, STORE_ID_V446, ["orders.read_write"]);

    // Uninstall
    const uninstallBody = JSON.stringify({ event: "app.store.uninstalled", merchant: STORE_ID_V446, data: {} });
    await app.request(await signedRequest(uninstallBody, INTERNAL_SECRET_V046), {}, env);

    // Re-install with later expires
    const laterExpires = futureExpires + 14 * 24 * 3600;
    const authBody2 = authorizeBody(STORE_ID_V446, laterExpires, "orders.read_write");
    await app.request(await signedRequest(authBody2, INTERNAL_SECRET_V046), {}, env);
    const token2 = await mintForStore(app, env, STORE_ID_V446, ["orders.read_write"]);

    // Old token is 401 (record was deleted and re-created; token1's JTI is not active_jti)
    const resOld = await mcpToolsList(app, env, token1);
    expect(resOld.status).toBe(401);

    // New token works
    const resNew = await mcpToolsList(app, env, token2);
    expect(resNew.status).toBe(200);
  });
});
