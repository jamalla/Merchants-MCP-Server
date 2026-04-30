#!/usr/bin/env node
// Generates an encrypted MerchantRecord JSON for seeding local dev KV.
// Run: node scripts/smoke-seed.mjs
// Then: wrangler kv key put --binding SALLA_TOKENS "store:smoke-123" "$(node scripts/smoke-seed.mjs)"

const TOKEN_ENC_KEY_V1_B64 = "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==";
const ENCRYPTION_SALT_B64 = "dGVzdC1zYWx0LTE2LWJ5dGVz";
const STORE_ID = "smoke-123";
const VERSION = 1;

function b64ToBytes(b64) {
  return Buffer.from(b64, "base64");
}
function bytesToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

async function deriveKey(storeId, version) {
  const rawKey = b64ToBytes(TOKEN_ENC_KEY_V1_B64);
  const salt = b64ToBytes(ENCRYPTION_SALT_B64);
  const info = new TextEncoder().encode(`salla-mcp:store:${storeId}`);

  const importedKey = await crypto.subtle.importKey("raw", rawKey, { name: "HKDF" }, false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    importedKey,
    256,
  );
  return crypto.subtle.importKey("raw", derivedBits, { name: "AES-GCM" }, false, ["encrypt"]);
}

async function encryptField(plaintext, storeId, version) {
  const key = await deriveKey(storeId, version);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ptBytes);
  return { ct: bytesToB64(new Uint8Array(ctBuf)), iv: bytesToB64(iv) };
}

const accessEnc = await encryptField("smoke-access-token-value", STORE_ID, VERSION);
const refreshEnc = await encryptField("smoke-refresh-token-value", STORE_ID, VERSION);

const record = {
  store_id: STORE_ID,
  scopes: ["orders.read_write", "products.read_write", "shipments.read"],
  access_token_ct: accessEnc.ct,
  access_token_iv: accessEnc.iv,
  refresh_token_ct: refreshEnc.ct,
  refresh_token_iv: refreshEnc.iv,
  access_expires_at: Date.now() + 3_600_000,
  refresh_expires_at: Date.now() + 30 * 24 * 3_600_000,
  active_jti: null,
  installed_at: Date.now(),
  updated_at: Date.now(),
  key_version: 1,
  status: "active",
  schema_version: 1,
};

process.stdout.write(JSON.stringify(record));
