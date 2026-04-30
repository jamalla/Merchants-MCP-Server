import type { Context } from "hono";
import type { Env, MerchantRecord, RevokedJTI } from "../types.js";
import { hmacSha256Hex, timingSafeEqualHex, sha256Hex } from "../lib/hmac.js";
import { encryptField, currentKeyVersion } from "../lib/crypto.js";
import { createLogger, type Logger } from "../middleware/logger.js";
import { MAX_INSTALL_URL_LIFETIME_SECONDS } from "../constants.js";

// ── Secret helpers ────────────────────────────────────────────────────────────

function getWebhookSecrets(env: Env): string[] {
  const secrets: string[] = [];
  for (let v = 1; v <= 9; v++) {
    const secret = (env as unknown as Record<string, unknown>)[`SALLA_WEBHOOK_SECRET_V${v}`] as
      | string
      | undefined;
    if (secret) secrets.push(secret);
  }
  return secrets;
}

// ── Signature verification (T024) ─────────────────────────────────────────────

/**
 * Normalize the raw signature header value.
 * Handles raw hex OR sha256={hex} prefixed format defensively (🟡 format unverified).
 */
function normalizeSig(raw: string): string {
  return raw.startsWith("sha256=") ? raw.slice(7) : raw;
}

export async function verifyWebhookSignature(
  env: Env,
  body: ArrayBuffer,
  sigHeader: string,
): Promise<boolean> {
  const sig = normalizeSig(sigHeader.trim());
  const secrets = getWebhookSecrets(env);
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, body);
    if (timingSafeEqualHex(sig, expected)) return true;
  }
  return false;
}

// ── Payload helpers ───────────────────────────────────────────────────────────

function parseScope(scope: unknown): string[] {
  if (Array.isArray(scope)) return (scope as unknown[]).map(String).filter(Boolean);
  if (typeof scope === "string") return scope.split(" ").filter(Boolean);
  return [];
}

// ── Main dispatch handler (T025 + app.updated + app.store.uninstalled) ────────

export async function handleSallaWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const logger = createLogger(c);
  const start = Date.now();

  // Read raw body once — needed for HMAC, then parsed as JSON
  const rawBody = await c.req.raw.clone().arrayBuffer();

  // Signature header: working assumption is X-Salla-Signature (🟡 unverified).
  // Fallback: Authorization: Bearer {hex} (seen in some Salla integrations).
  let sigHeader = c.req.header("X-Salla-Signature");
  if (!sigHeader) {
    const auth = c.req.header("Authorization");
    if (auth?.startsWith("Bearer ")) sigHeader = auth.slice(7);
  }

  if (!sigHeader) {
    logger.warn("salla_webhook", {
      outcome: "signature_invalid",
      status_code: 403,
      latency_ms: Date.now() - start,
    });
    return new Response(null, { status: 403 });
  }

  const valid = await verifyWebhookSignature(c.env, rawBody, sigHeader);
  if (!valid) {
    logger.warn("salla_webhook", {
      outcome: "signature_invalid",
      status_code: 403,
      latency_ms: Date.now() - start,
    });
    return new Response(null, { status: 403 });
  }

  // Parse JSON only AFTER signature is verified
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (!payload || typeof payload !== "object") {
    return c.json({ error: "invalid_payload" }, 400);
  }

  const p = payload as Record<string, unknown>;
  const event = p["event"];

  // store_id: working assumption is top-level `merchant` field (🟡 unverified).
  const merchantRaw = p["merchant"];
  const storeId = merchantRaw != null ? String(merchantRaw) : "";

  if (!storeId) {
    logger.warn("salla_webhook", {
      outcome: "missing_store_id",
      status_code: 400,
      latency_ms: Date.now() - start,
    });
    return c.json({ error: "missing_store_id" }, 400);
  }

  switch (event) {
    case "app.store.authorize":
      return handleAuthorize(c, logger, start, storeId, p["data"]);

    case "app.updated":
      return handleUpdated(c, logger, start, storeId);

    case "app.store.uninstalled":
    case "app.uninstalled":
      return handleUninstalled(c, logger, start, storeId, String(event));

    default:
      logger.warn("salla_webhook", {
        webhook_event: String(event ?? "unknown"),
        outcome: "unknown_event",
        status_code: 200,
        latency_ms: Date.now() - start,
      });
      return c.json({}, 200);
  }
}

// ── app.store.authorize ───────────────────────────────────────────────────────

async function handleAuthorize(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  start: number,
  storeId: string,
  data: unknown,
): Promise<Response> {
  if (!data || typeof data !== "object") {
    return c.json({ error: "invalid_data" }, 400);
  }

  const d = data as Record<string, unknown>;
  const accessToken = typeof d["access_token"] === "string" ? d["access_token"] : "";
  const refreshToken = typeof d["refresh_token"] === "string" ? d["refresh_token"] : "";
  const expiresRaw = d["expires"];
  const scope = parseScope(d["scope"]);

  if (!accessToken || !refreshToken || expiresRaw == null) {
    logger.warn("salla_webhook", {
      webhook_event: "app.store.authorize",
      store_id: storeId,
      outcome: "invalid_payload",
      status_code: 400,
      latency_ms: Date.now() - start,
    });
    return c.json({ error: "invalid_payload" }, 400);
  }

  // expires is an ABSOLUTE Unix timestamp (seconds) per Salla docs and contracts/webhooks.md.
  // Do NOT add to Date.now(). Convert seconds → ms.
  const accessExpiresAtMs = Number(expiresRaw) * 1000;
  const now = Date.now();

  // Read existing record for replay protection and installed_at preservation
  const existingRaw = await c.env.SALLA_TOKENS.get(`store:${storeId}`);
  const existing = existingRaw ? (JSON.parse(existingRaw) as MerchantRecord) : null;

  // Replay / reorder protection (FR-006): if incoming token expires before or at
  // the same time as what we already have, this is an older event — ignore it.
  if (existing && accessExpiresAtMs <= existing.access_expires_at) {
    logger.warn("salla_webhook", {
      webhook_event: "app.store.authorize",
      store_id: storeId,
      outcome: "replay_ignored",
      status_code: 200,
      latency_ms: Date.now() - start,
    });
    return c.json({ outcome: "replay_ignored" }, 200);
  }

  const keyVersion = currentKeyVersion(c.env);
  const [accessEnc, refreshEnc] = await Promise.all([
    encryptField(accessToken, c.env, storeId, keyVersion),
    encryptField(refreshToken, c.env, storeId, keyVersion),
  ]);

  const record: MerchantRecord = {
    store_id: storeId,
    scopes: scope,
    access_token_ct: accessEnc.ct,
    access_token_iv: accessEnc.iv,
    refresh_token_ct: refreshEnc.ct,
    refresh_token_iv: refreshEnc.iv,
    access_expires_at: accessExpiresAtMs,
    refresh_expires_at: now + 30 * 24 * 3600 * 1000,
    active_jti: existing?.active_jti ?? null,
    installed_at: existing?.installed_at ?? now,
    updated_at: now,
    key_version: keyVersion,
    status: "active",
    schema_version: 1,
  };

  await c.env.SALLA_TOKENS.put(`store:${storeId}`, JSON.stringify(record));

  logger.info("salla_webhook", {
    webhook_event: "app.store.authorize",
    store_id: storeId,
    outcome: "stored",
    status_code: 200,
    latency_ms: Date.now() - start,
  });

  return c.json({ outcome: "stored" }, 200);
}

// ── app.updated ───────────────────────────────────────────────────────────────

async function handleUpdated(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  start: number,
  storeId: string,
): Promise<Response> {
  // Notification-only per Salla docs: new tokens arrive in subsequent app.store.authorize.
  // Only update updated_at for audit purposes; do NOT modify tokens, scopes, or expiry.
  const existingRaw = await c.env.SALLA_TOKENS.get(`store:${storeId}`);
  if (!existingRaw) {
    logger.warn("salla_webhook", {
      webhook_event: "app.updated",
      store_id: storeId,
      outcome: "store_not_found",
      status_code: 200,
      latency_ms: Date.now() - start,
    });
    return c.json({ outcome: "store_not_found" }, 200);
  }

  const record = JSON.parse(existingRaw) as MerchantRecord;
  record.updated_at = Date.now();
  await c.env.SALLA_TOKENS.put(`store:${storeId}`, JSON.stringify(record));

  logger.info("salla_webhook", {
    webhook_event: "app.updated",
    store_id: storeId,
    outcome: "notification_processed",
    status_code: 200,
    latency_ms: Date.now() - start,
  });

  return c.json({ outcome: "notification_processed" }, 200);
}

// ── app.store.uninstalled / app.uninstalled ───────────────────────────────────

async function handleUninstalled(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  start: number,
  storeId: string,
  eventName: string,
): Promise<Response> {
  // Denylist the active JTI before deletion so pre-uninstall tokens stay invalid
  // even if the merchant re-installs later (new record → new mint, but old JTI still blocked).
  const existingRaw = await c.env.SALLA_TOKENS.get(`store:${storeId}`);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as MerchantRecord;
      if (existing.active_jti) {
        const jtiHash = await sha256Hex(existing.active_jti);
        const denylistEntry: RevokedJTI = {
          revoked_at: Date.now(),
          reason: "uninstalled",
          store_id: storeId,
        };
        await c.env.JWT_DENYLIST.put(
          `jti:${jtiHash}`,
          JSON.stringify(denylistEntry),
          { expirationTtl: MAX_INSTALL_URL_LIFETIME_SECONDS + 60 },
        );
      }
    } catch {
      // Malformed record — proceed with deletion regardless
    }
  }

  // KV delete is a no-op on missing key — inherently idempotent.
  await c.env.SALLA_TOKENS.delete(`store:${storeId}`);

  logger.info("salla_webhook", {
    webhook_event: eventName,
    store_id: storeId,
    outcome: "uninstalled",
    status_code: 200,
    latency_ms: Date.now() - start,
  });

  return c.json({ outcome: "uninstalled" }, 200);
}
