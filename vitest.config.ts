import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["SALLA_TOKENS", "JWT_DENYLIST"],
          bindings: {
            ACTIVE_KEY_VERSION: "1",
            MCP_ISSUER: "https://mcp.salla.dev",
            MCP_AUDIENCE: "salla-merchant-mcp",
            REFRESH_WINDOW_SECONDS: "3600",
            MAX_INSTALL_URL_LIFETIME_SECONDS: "7776000",
            TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
            ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
            JWT_SIGNING_SECRET: "test-jwt-signing-secret-for-unit-tests",
            SALLA_WEBHOOK_SECRET_V1: "test-webhook-secret",
            INTERNAL_API_SECRET_V1: "test-internal-secret",
            SALLA_CLIENT_ID: "test-client-id",
            SALLA_CLIENT_SECRET: "test-client-secret",
          },
          rateLimits: {
            RATE_LIMITER: { limit: 60, period: 60 },
          },
        },
      },
    },
    include: ["tests/unit/**/*.test.ts"],
  },
});
