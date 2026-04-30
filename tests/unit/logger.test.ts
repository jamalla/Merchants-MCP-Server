import { describe, it, expect } from "vitest";
import { sanitizeFields } from "../../src/middleware/logger.js";

describe("logger sanitization", () => {
  it("allows all permitted fields through", () => {
    const fields = {
      store_id: "store-123",
      jti: "some-jti",
      tool_name: "list_orders",
      method: "POST",
      endpoint: "/v1/mcp",
      webhook_event: "app.store.authorize",
      outcome: "stored",
      status_code: 200,
      latency_ms: 42,
      event: "tool_call",
      level: "info",
      ts: 1234567890,
      request_id: "req-uuid",
    };

    const result = sanitizeFields(fields);
    expect(result).toMatchObject(fields);
  });

  it("drops non-allowlisted fields", () => {
    const fields = {
      store_id: "store-123",
      user_email: "merchant@example.com",
      ip_address: "1.2.3.4",
      custom_field: "value",
    };

    const result = sanitizeFields(fields);
    expect(result).toHaveProperty("store_id");
    expect(result).not.toHaveProperty("user_email");
    expect(result).not.toHaveProperty("ip_address");
    expect(result).not.toHaveProperty("custom_field");
  });

  it("drops fields matching token patterns", () => {
    const fields = {
      store_id: "store-123",
    };

    // These are not in allowlist so they'd be dropped anyway,
    // but confirm the sanitizer doesn't accidentally expose them
    const withTokenFields = {
      ...fields,
      access_token: "bearer-token-value",
      refresh_token: "refresh-value",
      secret: "my-secret",
      signing_key: "my-signing-key",
    };

    const result = sanitizeFields(withTokenFields);
    expect(result).toHaveProperty("store_id");
    expect(result).not.toHaveProperty("access_token");
    expect(result).not.toHaveProperty("refresh_token");
    expect(result).not.toHaveProperty("secret");
    expect(result).not.toHaveProperty("signing_key");
  });

  it("drops values that look like tokens (very long strings)", () => {
    const fields = {
      store_id: "a".repeat(201),
    };

    const result = sanitizeFields(fields);
    expect(result).not.toHaveProperty("store_id");
  });

  it("does not pass scope arrays through", () => {
    const fields = {
      store_id: "store-123",
      scope: ["orders:read", "products:read"],
    };

    const result = sanitizeFields(fields);
    expect(result).toHaveProperty("store_id");
    // scope is not in allowed fields and also matches token pattern
    expect(result).not.toHaveProperty("scope");
  });

  it("preserves numeric status_code and latency_ms", () => {
    const result = sanitizeFields({ status_code: 200, latency_ms: 15 });
    expect(result.status_code).toBe(200);
    expect(result.latency_ms).toBe(15);
  });

  it("does NOT drop outcome values that contain the word 'scope'", () => {
    // outcome: "insufficient_scope" is a legitimate log entry — it must not be silently dropped
    const result = sanitizeFields({ outcome: "insufficient_scope" });
    expect(result.outcome).toBe("insufficient_scope");
  });
});
