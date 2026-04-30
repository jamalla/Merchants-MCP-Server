import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../src/middleware/auth.js";
import { signJWT } from "../../src/lib/jwt.js";
import { sha256Hex } from "../../src/lib/hmac.js";
import type { Env, MerchantRecord, StoreContext } from "../../src/types.js";

function makeKvMock(data: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(data));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, caret: undefined }),
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SALLA_TOKENS: makeKvMock(),
    JWT_DENYLIST: makeKvMock(),
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-signing-secret-auth-tests",
    SALLA_WEBHOOK_SECRET_V1: "test-webhook-secret",
    INTERNAL_API_SECRET_V1: "test-internal-secret",
    SALLA_CLIENT_ID: "test-client-id",
    SALLA_CLIENT_SECRET: "test-client-secret",
    MCP_ISSUER: "https://mcp.salla.dev",
    MCP_AUDIENCE: "salla-merchant-mcp",
    REFRESH_WINDOW_SECONDS: "3600",
    MAX_INSTALL_URL_LIFETIME_SECONDS: "7776000",
    ...overrides,
  };
}

function makeMerchantRecord(overrides: Partial<MerchantRecord> = {}): MerchantRecord {
  return {
    store_id: "store-123",
    scopes: ["orders.read_write"],
    access_token_ct: "fake-ct",
    access_token_iv: "fake-iv",
    refresh_token_ct: "fake-refresh-ct",
    refresh_token_iv: "fake-refresh-iv",
    access_expires_at: Date.now() + 3_600_000,
    refresh_expires_at: Date.now() + 30 * 24 * 3_600_000,
    active_jti: null,
    installed_at: Date.now(),
    updated_at: Date.now(),
    key_version: 1,
    status: "active",
    schema_version: 1,
    ...overrides,
  };
}

async function mintToken(env: Env, overrides: Record<string, unknown> = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return signJWT(
    {
      sub: "store-123",
      store_id: "store-123",
      jti: crypto.randomUUID(),
      iat: nowSec,
      exp: nowSec + 7_776_000,
      scope: ["orders.read_write"],
      ...overrides,
    },
    env,
  );
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => {
    Object.assign(c.env, env);
    return next();
  });
  app.all("/v1/mcp", authMiddleware, (c) => {
    const ctx = c.get("storeContext") as StoreContext;
    return c.json({ ok: true, storeId: ctx.storeId, jti: ctx.jti, scopes: ctx.effectiveScopes });
  });
  return app;
}

const ENDPOINT = "http://localhost/v1/mcp";

describe("auth middleware", () => {
  it("valid Bearer token → 200 with populated storeContext", async () => {
    const record = makeMerchantRecord();
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
    });
    const token = await mintToken(env);
    const app = makeApp(env);

    const res = await app.request(
      new Request(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } }),
      {},
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { storeId: string; scopes: string[] };
    expect(body.storeId).toBe("store-123");
    expect(body.scopes).toEqual(["orders.read_write"]);
  });

  it("expired JWT → 401 invalid_token with WWW-Authenticate header", async () => {
    const record = makeMerchantRecord();
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await mintToken(env, { exp: nowSec - 1 });
    const app = makeApp(env);

    const res = await app.request(
      new Request(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } }),
      {},
      env,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("tampered signature → 401 invalid_token", async () => {
    const record = makeMerchantRecord();
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
    });
    const token = await mintToken(env);
    const [header, payload] = token.split(".");
    const tampered = `${header}.${payload}.badsignature`;
    const app = makeApp(env);

    const res = await app.request(
      new Request(ENDPOINT, { headers: { Authorization: `Bearer ${tampered}` } }),
      {},
      env,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("JTI on denylist → 401 invalid_token", async () => {
    const jti = "revoked-jti-" + crypto.randomUUID();
    const jtiHash = await sha256Hex(jti);
    const record = makeMerchantRecord();
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
      JWT_DENYLIST: makeKvMock({ [`jti:${jtiHash}`]: "1" }),
    });
    const token = await mintToken(env, { jti });
    const app = makeApp(env);

    const res = await app.request(
      new Request(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } }),
      {},
      env,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("missing merchant record → 401 invalid_token", async () => {
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({}),
    });
    const token = await mintToken(env);
    const app = makeApp(env);

    const res = await app.request(
      new Request(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } }),
      {},
      env,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("status=refresh_failed → 401 reinstall_required with error_description in WWW-Authenticate", async () => {
    const record = makeMerchantRecord({ status: "refresh_failed" });
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
    });
    const token = await mintToken(env);
    const app = makeApp(env);

    const res = await app.request(
      new Request(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } }),
      {},
      env,
    );

    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("reinstall_required");
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    expect(wwwAuth).toContain("error_description");
  });

  it("token in header and query (same) → 200, no conflict", async () => {
    const record = makeMerchantRecord();
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
    });
    const token = await mintToken(env);
    const app = makeApp(env);

    const res = await app.request(
      new Request(`${ENDPOINT}?token=${token}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      {},
      env,
    );

    expect(res.status).toBe(200);
  });

  it("token in header and query (different) → uses header value, returns 200", async () => {
    const record = makeMerchantRecord();
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
    });
    const headerToken = await mintToken(env);
    const app = makeApp(env);

    const res = await app.request(
      new Request(`${ENDPOINT}?token=invalid.bogus.token`, {
        headers: { Authorization: `Bearer ${headerToken}` },
      }),
      {},
      env,
    );

    expect(res.status).toBe(200);
  });

  it("rate limit exceeded → 429 rate_limit_exceeded with Retry-After: 60", async () => {
    const record = makeMerchantRecord();
    const env = makeEnv({
      SALLA_TOKENS: makeKvMock({ "store:store-123": JSON.stringify(record) }),
      RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    const token = await mintToken(env);
    const app = makeApp(env);

    const res = await app.request(
      new Request(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } }),
      {},
      env,
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limit_exceeded" });
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
