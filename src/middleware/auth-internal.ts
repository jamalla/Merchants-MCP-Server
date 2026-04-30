import type { MiddlewareHandler } from "hono";
import { hmacSha256Hex, timingSafeEqualHex } from "../lib/hmac.js";
import type { Env } from "../types.js";
import { createLogger } from "./logger.js";

const TIMESTAMP_SKEW_SECONDS = 300;

function getInternalSecrets(env: Env): string[] {
  const secrets: string[] = [];
  // Try versions in priority order: V1, V2, ...
  for (let v = 1; v <= 9; v++) {
    const key = `INTERNAL_API_SECRET_V${v}` as keyof Env;
    const secret = env[key] as string | undefined;
    if (secret) {
      secrets.push(secret);
    }
  }
  return secrets;
}

export const authInternalMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const logger = createLogger(c);

  const authHeader = c.req.header("X-Salla-Internal-Auth");
  const timestampHeader = c.req.header("X-Salla-Internal-Timestamp");

  if (!authHeader || !timestampHeader) {
    logger.warn("internal_auth_failed", { outcome: "missing_headers" });
    return c.json({ error: "unauthorized" }, 401);
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) {
    logger.warn("internal_auth_failed", { outcome: "invalid_timestamp" });
    return c.json({ error: "unauthorized" }, 401);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > TIMESTAMP_SKEW_SECONDS) {
    logger.warn("internal_auth_failed", { outcome: "timestamp_outside_window" });
    return c.json({ error: "unauthorized" }, 401);
  }

  const rawBody = await c.req.raw.clone().text();
  const message = `${timestampHeader}.${rawBody}`;

  const secrets = getInternalSecrets(c.env);
  if (secrets.length === 0) {
    logger.warn("internal_auth_failed", { outcome: "no_secrets_configured" });
    return c.json({ error: "unauthorized" }, 401);
  }

  let valid = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, message);
    if (timingSafeEqualHex(authHeader, expected)) {
      valid = true;
      break;
    }
  }

  if (!valid) {
    logger.warn("internal_auth_failed", { outcome: "hmac_mismatch" });
    return c.json({ error: "unauthorized" }, 401);
  }

  return await next();
};
