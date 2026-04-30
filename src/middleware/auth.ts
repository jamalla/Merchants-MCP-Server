import type { MiddlewareHandler } from "hono";
import { verifyJWT, JWTVerificationError } from "../lib/jwt.js";
import { sha256Hex } from "../lib/hmac.js";
import { scopeIntersection } from "../lib/scope.js";
import { RefreshFailedError } from "../lib/token-store.js";
import type { Env, InstallURLTokenPayload, MerchantRecord, StoreContext } from "../types.js";
import { createLogger } from "./logger.js";

declare module "hono" {
  interface ContextVariableMap {
    storeContext: StoreContext;
    accessToken: string;
  }
}

function invalidTokenResponse(c: Parameters<MiddlewareHandler>[0]) {
  c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
  return c.json({ error: "invalid_token" }, 401);
}

function reinstallRequiredResponse(c: Parameters<MiddlewareHandler>[0]) {
  c.header(
    "WWW-Authenticate",
    'Bearer error="invalid_token", error_description="Reinstall the Salla MCP app to restore connectivity"',
  );
  return c.json(
    {
      error: "reinstall_required",
      detail:
        "The Salla refresh token has been invalidated. Please reinstall the Salla MCP app from the Salla App Store.",
    },
    401,
  );
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const logger = createLogger(c);

  // FR-027: dual-source token extraction — header preferred over query param
  const authHeader = c.req.header("Authorization");
  const queryToken = c.req.query("token");

  let token: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
    if (queryToken && queryToken !== token) {
      // Both present and different — log WARN with JTI only (extracted after verify)
      // We'll log after the JWT is verified so we have the JTI
      c.set("_tokenSourceConflict" as never, true as never);
    }
  } else if (queryToken) {
    token = queryToken;
  }

  if (!token) {
    return invalidTokenResponse(c);
  }

  // Step 1–3: verify HS256 signature, exp, iss/aud
  let payload: InstallURLTokenPayload;
  try {
    payload = await verifyJWT(token, c.env);
  } catch (err) {
    if (err instanceof JWTVerificationError) {
      logger.warn("auth_failed", { outcome: err.code, event: "auth_failed" });
    }
    return invalidTokenResponse(c);
  }

  // Log the token source conflict WARN now that we have the JTI
  if (c.get("_tokenSourceConflict" as never)) {
    logger.warn("token_source_conflict", {
      outcome: "token_source_conflict",
      jti: payload.jti,
      event: "auth_failed",
    });
  }

  // Step 4: denylist check — sha256(jti) lookup in JWT_DENYLIST
  const jtiHash = await sha256Hex(payload.jti);
  const denylistEntry = await c.env.JWT_DENYLIST.get(`jti:${jtiHash}`);
  if (denylistEntry !== null) {
    logger.warn("auth_failed", { outcome: "jti_revoked", jti: payload.jti, event: "auth_failed" });
    return invalidTokenResponse(c);
  }

  // Step 5: read merchant record
  const storeId = payload.sub;
  const raw = await c.env.SALLA_TOKENS.get(`store:${storeId}`);
  if (!raw) {
    logger.warn("auth_failed", {
      outcome: "no_merchant_record",
      store_id: storeId,
      event: "auth_failed",
    });
    return invalidTokenResponse(c);
  }

  let record: MerchantRecord;
  try {
    record = JSON.parse(raw) as MerchantRecord;
  } catch {
    return invalidTokenResponse(c);
  }

  // Step 6: status check
  if (record.status === "refresh_failed") {
    logger.warn("auth_failed", {
      outcome: "refresh_failed",
      store_id: storeId,
      event: "auth_failed",
    });
    return reinstallRequiredResponse(c);
  }

  // Step 7: compute effective scopes
  const effectiveScopes = scopeIntersection(payload.scope, record.scopes);

  // Step 8: rate limit (keyed per JTI — protects individual install URLs)
  const rateResult = await c.env.RATE_LIMITER.limit({ key: payload.jti });
  if (!rateResult.success) {
    c.header("Retry-After", "60");
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }

  // Inject StoreContext for downstream handlers
  const storeCtx: StoreContext = {
    storeId,
    jti: payload.jti,
    effectiveScopes,
    record,
    accessToken: "", // populated lazily by token-store; not decoded here to avoid extra crypto
  };

  c.set("storeContext", storeCtx);
  return await next();
};
