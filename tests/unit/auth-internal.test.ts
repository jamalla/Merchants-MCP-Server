import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authInternalMiddleware } from "../../src/middleware/auth-internal.js";
import { hmacSha256Hex } from "../../src/lib/hmac.js";
import type { Env } from "../../src/types.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SALLA_TOKENS: {} as KVNamespace,
    JWT_DENYLIST: {} as KVNamespace,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-secret",
    SALLA_WEBHOOK_SECRET_V1: "test-webhook-secret",
    INTERNAL_API_SECRET_V1: "test-internal-secret-v1",
    SALLA_CLIENT_ID: "test-client-id",
    SALLA_CLIENT_SECRET: "test-client-secret",
    MCP_ISSUER: "https://mcp.salla.dev",
    MCP_AUDIENCE: "salla-merchant-mcp",
    REFRESH_WINDOW_SECONDS: "3600",
    MAX_INSTALL_URL_LIFETIME_SECONDS: "7776000",
    ...overrides,
  };
}

function makeApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => {
    Object.assign(c.env, env);
    return next();
  });
  app.post("/internal/test", authInternalMiddleware, (c) => c.json({ ok: true }));
  return app;
}

async function makeRequest(
  body: string,
  secret: string,
  timestampOverride?: number,
): Promise<{ request: Request; timestamp: number; hmac: string }> {
  const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
  const message = `${timestamp}.${body}`;
  const hmac = await hmacSha256Hex(secret, message);
  const request = new Request("http://localhost/internal/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Salla-Internal-Auth": hmac,
      "X-Salla-Internal-Timestamp": String(timestamp),
    },
    body,
  });
  return { request, timestamp, hmac };
}

describe("auth-internal middleware", () => {
  it("allows valid HMAC + in-window timestamp", async () => {
    const env = makeEnv();
    const app = makeApp(env);
    const body = JSON.stringify({ store_id: "123" });
    const { request } = await makeRequest(body, "test-internal-secret-v1");

    const res = await app.request(request, {}, env);
    expect(res.status).toBe(200);
  });

  it("rejects missing X-Salla-Internal-Auth header", async () => {
    const env = makeEnv();
    const app = makeApp(env);

    const timestamp = Math.floor(Date.now() / 1000);
    const request = new Request("http://localhost/internal/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Salla-Internal-Timestamp": String(timestamp),
      },
      body: "{}",
    });

    const res = await app.request(request, {}, env);
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("unauthorized");
  });

  it("rejects missing X-Salla-Internal-Timestamp header", async () => {
    const env = makeEnv();
    const app = makeApp(env);

    const request = new Request("http://localhost/internal/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Salla-Internal-Auth": "deadbeef",
      },
      body: "{}",
    });

    const res = await app.request(request, {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects timestamp older than 5 minutes", async () => {
    const env = makeEnv();
    const app = makeApp(env);
    const body = "{}";
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400;
    const { request } = await makeRequest(body, "test-internal-secret-v1", oldTimestamp);

    const res = await app.request(request, {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects timestamp from far future", async () => {
    const env = makeEnv();
    const app = makeApp(env);
    const body = "{}";
    const futureTimestamp = Math.floor(Date.now() / 1000) + 400;
    const { request } = await makeRequest(body, "test-internal-secret-v1", futureTimestamp);

    const res = await app.request(request, {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects invalid HMAC", async () => {
    const env = makeEnv();
    const app = makeApp(env);
    const body = "{}";
    const timestamp = Math.floor(Date.now() / 1000);
    const wrongHmac = await hmacSha256Hex("wrong-secret", `${timestamp}.${body}`);

    const request = new Request("http://localhost/internal/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Salla-Internal-Auth": wrongHmac,
        "X-Salla-Internal-Timestamp": String(timestamp),
      },
      body,
    });

    const res = await app.request(request, {}, env);
    expect(res.status).toBe(401);
  });

  it("secret rotation: signing with V1 validates while V2 is the primary", async () => {
    const env = makeEnv({
      INTERNAL_API_SECRET_V1: "old-secret-v1",
      INTERNAL_API_SECRET_V2: "new-secret-v2",
    });
    const app = makeApp(env);
    const body = JSON.stringify({ store_id: "456" });

    // Sign with V1 (old secret)
    const { request } = await makeRequest(body, "old-secret-v1");
    const res = await app.request(request, {}, env);
    expect(res.status).toBe(200);
  });
});
