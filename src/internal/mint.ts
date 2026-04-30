import type { Context } from "hono";
import { z } from "zod";
import { encryptField, decryptField, currentKeyVersion } from "../lib/crypto.js";
import { signJWT } from "../lib/jwt.js";
import { sha256Hex } from "../lib/hmac.js";
import type { Env, MerchantRecord, RevokedJTI } from "../types.js";
import { createLogger } from "../middleware/logger.js";
import { DEFAULT_INSTALL_URL_LIFETIME_SECONDS, MAX_INSTALL_URL_LIFETIME_SECONDS } from "../constants.js";

const mintRequestSchema = z.object({
  store_id: z.string().min(1),
  scopes: z.array(z.string()),
  lifetime_seconds: z.number().int().positive().optional(),
});

export async function handleMintRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const logger = createLogger(c);
  const startMs = Date.now();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", detail: "Request body must be valid JSON" }, 400);
  }

  const parsed = mintRequestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.errors[0]?.message ?? "invalid request body";
    return c.json({ error: "invalid_request", detail }, 400);
  }

  const { store_id: storeId, scopes: requestedScopes, lifetime_seconds } = parsed.data;

  const lifetimeSec = lifetime_seconds ?? DEFAULT_INSTALL_URL_LIFETIME_SECONDS;
  if (lifetimeSec > MAX_INSTALL_URL_LIFETIME_SECONDS) {
    return c.json({ error: "invalid_lifetime" }, 400);
  }

  const raw = await c.env.SALLA_TOKENS.get(`store:${storeId}`);
  if (!raw) {
    return c.json({ error: "store_not_found" }, 404);
  }

  let record: MerchantRecord;
  try {
    record = JSON.parse(raw) as MerchantRecord;
  } catch {
    return c.json({ error: "store_not_found" }, 404);
  }

  // Scope-subset check: requested scopes must be ⊆ merchant's granted scopes (FR-defense-in-depth)
  const grantedScopeSet = new Set(record.scopes);
  for (const scope of requestedScopes) {
    if (!grantedScopeSet.has(scope)) {
      return c.json(
        { error: "invalid_scopes", detail: "Requested scopes exceed merchant grant" },
        400,
      );
    }
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const expSec = nowSec + lifetimeSec;

  // Atomically revoke the previous active JTI before issuing a new one
  if (record.active_jti) {
    const oldJtiHash = await sha256Hex(record.active_jti);
    const denylistEntry: RevokedJTI = {
      revoked_at: nowMs,
      reason: "regenerated",
      store_id: storeId,
    };
    await c.env.JWT_DENYLIST.put(
      `jti:${oldJtiHash}`,
      JSON.stringify(denylistEntry),
      { expirationTtl: MAX_INSTALL_URL_LIFETIME_SECONDS + 60 },
    );
  }

  const jti = crypto.randomUUID();

  const jwtToken = await signJWT(
    {
      sub: storeId,
      store_id: storeId,
      jti,
      iat: nowSec,
      exp: expSec,
      scope: requestedScopes,
    },
    c.env,
  );

  // Opportunistic key rotation: re-encrypt tokens if the active key version has advanced
  const keyVersion = currentKeyVersion(c.env);
  let updatedRecord: MerchantRecord;

  if (keyVersion !== record.key_version) {
    const [accessToken, refreshToken] = await Promise.all([
      decryptField(record.access_token_ct, record.access_token_iv, c.env, storeId, record.key_version),
      decryptField(record.refresh_token_ct, record.refresh_token_iv, c.env, storeId, record.key_version),
    ]);
    const [accessEnc, refreshEnc] = await Promise.all([
      encryptField(accessToken, c.env, storeId, keyVersion),
      encryptField(refreshToken, c.env, storeId, keyVersion),
    ]);
    updatedRecord = {
      ...record,
      access_token_ct: accessEnc.ct,
      access_token_iv: accessEnc.iv,
      refresh_token_ct: refreshEnc.ct,
      refresh_token_iv: refreshEnc.iv,
      key_version: keyVersion,
      active_jti: jti,
      updated_at: nowMs,
    };
  } else {
    updatedRecord = { ...record, active_jti: jti, updated_at: nowMs };
  }

  await c.env.SALLA_TOKENS.put(`store:${storeId}`, JSON.stringify(updatedRecord));

  const baseUrl = c.env.MCP_ISSUER;
  const installUrl = `${baseUrl}/v1/mcp?token=${jwtToken}`;

  logger.info("internal_api", {
    event: "internal_api",
    endpoint: "mint",
    store_id: storeId,
    jti,
    status_code: 200,
    latency_ms: Date.now() - startMs,
  });

  return c.json({ install_url: installUrl, jti, expires_at: expSec }, 200);
}
