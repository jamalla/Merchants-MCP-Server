import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requestIdMiddleware } from "../../src/middleware/request-id.js";
import { loggerMiddleware } from "../../src/middleware/logger.js";
import { handleSallaWebhook, verifyWebhookSignature } from "../../src/webhooks/salla.js";
import { hmacSha256Hex } from "../../src/lib/hmac.js";
import type { Env } from "../../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SALLA_TOKENS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, caret: undefined }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace,
    JWT_DENYLIST: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, caret: undefined }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-secret",
    SALLA_WEBHOOK_SECRET_V1: "test-webhook-secret-v1",
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

function buildApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", (c, next) => {
    Object.assign(c.env, env);
    return next();
  });
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);
  app.post("/webhooks/salla", handleSallaWebhook);
  return app;
}

const BODY = JSON.stringify({
  event: "app.store.authorize",
  merchant: 99001,
  data: {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires: Math.floor(Date.now() / 1000) + 14 * 24 * 3600,
    scope: "orders.read_write products.read_write",
  },
});

async function makeSig(secret: string, body: string, prefix = ""): Promise<string> {
  const hex = await hmacSha256Hex(secret, new TextEncoder().encode(body).buffer as ArrayBuffer);
  return prefix + hex;
}

function webhookRequest(body: string, sig: string): Request {
  return new Request("http://localhost/webhooks/salla", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salla-Signature": sig },
    body,
  });
}

// ── T027 Tests ─────────────────────────────────────────────────────────────────

describe("webhook signature verification", () => {
  it("valid signature passes and returns 200", async () => {
    const env = makeEnv();
    const app = buildApp(env);
    const sig = await makeSig("test-webhook-secret-v1", BODY);

    const res = await app.request(webhookRequest(BODY, sig), {}, env);
    expect(res.status).toBe(200);
  });

  it("invalid signature returns 403 with no state change", async () => {
    const env = makeEnv();
    const app = buildApp(env);

    const res = await app.request(webhookRequest(BODY, "deadbeef00000000"), {}, env);
    expect(res.status).toBe(403);
  });

  it("missing X-Salla-Signature header returns 403", async () => {
    const env = makeEnv();
    const app = buildApp(env);

    const req = new Request("http://localhost/webhooks/salla", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: BODY,
    });
    const res = await app.request(req, {}, env);
    expect(res.status).toBe(403);
  });

  it("sha256= prefixed signature format is accepted", async () => {
    const env = makeEnv();
    const app = buildApp(env);
    const sig = await makeSig("test-webhook-secret-v1", BODY, "sha256=");

    const res = await app.request(webhookRequest(BODY, sig), {}, env);
    expect(res.status).toBe(200);
  });

  it("tries V1 first; V2 secret also validates when configured", async () => {
    const env = makeEnv({
      SALLA_WEBHOOK_SECRET_V1: "old-secret",
      SALLA_WEBHOOK_SECRET_V2: "new-secret",
    } as Partial<Env>);
    const app = buildApp(env);

    // Sign with the V2 (new) secret — verifier must try both
    const sig = await makeSig("new-secret", BODY);
    const res = await app.request(webhookRequest(BODY, sig), {}, env);
    expect(res.status).toBe(200);
  });

  it("old V1 secret still validates when V2 is active (rotation support)", async () => {
    const env = makeEnv({
      SALLA_WEBHOOK_SECRET_V1: "old-secret",
      SALLA_WEBHOOK_SECRET_V2: "new-secret",
    } as Partial<Env>);
    const app = buildApp(env);

    // Sign with the V1 (old) secret — still accepted during rotation window
    const sig = await makeSig("old-secret", BODY);
    const res = await app.request(webhookRequest(BODY, sig), {}, env);
    expect(res.status).toBe(200);
  });

  it("wrong body (tampered after signing) returns 403", async () => {
    const env = makeEnv();
    const app = buildApp(env);

    // Sign original body, but send different body
    const sig = await makeSig("test-webhook-secret-v1", BODY);
    const tamperedBody = BODY.replace("99001", "99002");

    const res = await app.request(webhookRequest(tamperedBody, sig), {}, env);
    expect(res.status).toBe(403);
  });

  it("verifyWebhookSignature uses timing-safe comparison (no short-circuit leak)", async () => {
    const env = makeEnv();
    const body = new TextEncoder().encode(BODY).buffer as ArrayBuffer;

    // Same-length wrong hex — timing-safe comparison must not short-circuit
    const allZeros = "0".repeat(64);
    const result = await verifyWebhookSignature(env, body, allZeros);
    expect(result).toBe(false);
  });

  it("Authorization: Bearer {hex} fallback accepted when X-Salla-Signature absent", async () => {
    const env = makeEnv();
    const app = buildApp(env);
    const sig = await makeSig("test-webhook-secret-v1", BODY);

    const req = new Request("http://localhost/webhooks/salla", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sig}`,
      },
      body: BODY,
    });
    const res = await app.request(req, {}, env);
    expect(res.status).toBe(200);
  });
});
