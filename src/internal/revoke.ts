import type { Context } from "hono";
import { z } from "zod";
import { encryptField, decryptField, currentKeyVersion } from "../lib/crypto.js";
import { sha256Hex } from "../lib/hmac.js";
import type { Env, MerchantRecord, RevokedJTI } from "../types.js";
import { createLogger } from "../middleware/logger.js";
import { MAX_INSTALL_URL_LIFETIME_SECONDS } from "../constants.js";

const revokeRequestSchema = z.object({
  store_id: z.string().min(1),
  jti: z.string().min(1),
});

export async function handleRevokeRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const logger = createLogger(c);
  const startMs = Date.now();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", detail: "Request body must be valid JSON" }, 400);
  }

  const parsed = revokeRequestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.errors[0]?.message ?? "invalid request body";
    return c.json({ error: "invalid_request", detail }, 400);
  }

  const { store_id: storeId, jti } = parsed.data;

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

  const nowMs = Date.now();

  // Write to denylist regardless of whether this JTI is active — belt-and-braces per contract
  const jtiHash = await sha256Hex(jti);
  const denylistTtl = MAX_INSTALL_URL_LIFETIME_SECONDS + 60;
  const denylistEntry: RevokedJTI = {
    revoked_at: nowMs,
    reason: "manual",
    store_id: storeId,
  };
  await c.env.JWT_DENYLIST.put(`jti:${jtiHash}`, JSON.stringify(denylistEntry), { expirationTtl: denylistTtl });

  const isActive = record.active_jti === jti;
  let result: { revoked: boolean; reason: string };

  if (isActive) {
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
        active_jti: null,
        updated_at: nowMs,
      };
    } else {
      updatedRecord = { ...record, active_jti: null, updated_at: nowMs };
    }

    await c.env.SALLA_TOKENS.put(`store:${storeId}`, JSON.stringify(updatedRecord));
    result = { revoked: true, reason: "revoked" };
  } else {
    result = { revoked: false, reason: "already_revoked" };
  }

  logger.info("internal_api", {
    event: "internal_api",
    endpoint: "revoke",
    store_id: storeId,
    jti,
    status_code: 200,
    latency_ms: Date.now() - startMs,
  });

  return c.json(result, 200);
}
