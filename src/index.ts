import { Hono } from "hono";
import type { Env } from "./types.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { loggerMiddleware, createLogger } from "./middleware/logger.js";
import { authInternalMiddleware } from "./middleware/auth-internal.js";
import { authMiddleware } from "./middleware/auth.js";
import { handleMintRequest } from "./internal/mint.js";
import { handleRevokeRequest } from "./internal/revoke.js";
import { handleMcpRequest } from "./mcp/handler.js";
import { handleSallaWebhook } from "./webhooks/salla.js";

const app = new Hono<{ Bindings: Env }>();

// Global middleware — request-id must come before logger
app.use("*", requestIdMiddleware);
app.use("*", loggerMiddleware);

// 404 handler
app.notFound((c) => {
  return c.json({ error: "not_found" }, 404);
});

// Global error handler
app.onError((err, c) => {
  const logger = createLogger(c);
  logger.error("unhandled_error", {
    event: "unhandled_error",
    status_code: 500,
  });
  return c.json({ error: "internal_error" }, 500);
});

// US1: Webhook receiver — dispatches on event field after HMAC verification
app.post("/webhooks/salla", handleSallaWebhook);

// US2: Internal API — mint and revoke install URLs
app.post("/internal/mint", authInternalMiddleware, handleMintRequest);
app.post("/internal/revoke", authInternalMiddleware, handleRevokeRequest);

// US2: MCP endpoint — all HTTP methods (GET for SSE probe, POST for JSON-RPC)
app.all("/v1/mcp", authMiddleware, handleMcpRequest);

export default {
  fetch: app.fetch,
};
