# Data Model: Salla Merchant MCP Server

**Date**: 2026-04-29
**Branch**: `001-salla-merchant-mcp`

## Storage Overview

Two Workers KV namespaces. No relational database. No Durable Objects.

| Namespace binding | Purpose | Key patterns |
|-------------------|---------|--------------|
| `SALLA_TOKENS` | Encrypted merchant credentials + active JTI; refresh mutex sentinel | `store:{store_id}`, `refresh_lock:{store_id}` |
| `JWT_DENYLIST` | Revoked install URL JTI flags (hashed) | `jti:{sha256(jti)}` |

---

## Entity: MerchantRecord

Stored in `SALLA_TOKENS` under key `store:{store_id}`.
Value: a JSON envelope. Sensitive fields are AES-256-GCM ciphertext (base64). Non-sensitive fields are plaintext for audit, enumeration, and revocation utility.

```typescript
interface MerchantRecord {
  // --- identity (plaintext) ---
  store_id: string;                        // Salla store identifier; also embedded in the KV key
  merchant_id?: string;                    // Salla merchant identifier from /oauth2/user/info; optional, populated lazily

  // --- granted permissions (plaintext, used for scope intersection on every tool call) ---
  scopes: string[];                        // Live Salla scopes for this installation

  // --- encrypted credentials (AES-256-GCM with HKDF-derived per-store key) ---
  access_token_ct: string;                 // base64 ciphertext
  access_token_iv: string;                 // base64 96-bit IV
  refresh_token_ct: string;                // base64 ciphertext
  refresh_token_iv: string;                // base64 96-bit IV

  // Optional one-cycle retention of the prior refresh token, for recovery from
  // OUR OWN KV write failures only. Salla itself does NOT honor a grace window —
  // the previous refresh token is invalid the instant the new one is issued.
  // This field is dropped on the next successful refresh.
  previous_refresh_token_ct?: string;
  previous_refresh_token_iv?: string;

  // --- token metadata (plaintext) ---
  access_expires_at: number;               // Unix epoch ms — Salla access token expiry
  refresh_expires_at: number;              // Unix epoch ms — Salla refresh token expiry (~30 days)

  // --- install URL state (plaintext; rarely read on hot path) ---
  active_jti: string | null;               // jti of the currently active install URL; null if none

  // --- bookkeeping (plaintext) ---
  installed_at: number;                    // Unix epoch ms — first app.store.authorize
  updated_at: number;                      // Unix epoch ms — last write
  last_refreshed_at?: number;              // Unix epoch ms — last successful refresh
  last_used_at?: number;                   // Unix epoch ms — last successful tool call (best-effort, optional)

  // --- key rotation ---
  key_version: number;                     // Encryption key version used for the *_ct fields above

  // --- lifecycle ---
  status: 'active' | 'refresh_failed';
  schema_version: 1;
}
```

### Lifecycle

| Event | Action |
|-------|--------|
| `app.store.authorize` | Full upsert — encrypt with current `key_version`; set `installed_at` only on first write; set `status: 'active'` |
| `app.updated` | Overwrite tokens, scopes, `access_expires_at`, `refresh_expires_at`, `updated_at`, `key_version`; preserve `active_jti`, `installed_at` |
| `app.store.uninstalled` | `env.SALLA_TOKENS.delete('store:{store_id}')` — entire record removed |
| Token refresh (success) | Overwrite `access_token_ct/iv`, `refresh_token_ct/iv`, expiries, `last_refreshed_at`, `key_version`; move old refresh token to `previous_refresh_token_ct/iv` (one cycle) |
| Token refresh (failure, unrecoverable) | Set `status: 'refresh_failed'`; tokens are no longer valid; subsequent calls return 401 with re-install message per FR-021 |
| Mint new install URL | Overwrite `active_jti` with new jti; previous jti is added to JWT_DENYLIST in the same flow |
| Revoke install URL (explicit) | Overwrite `active_jti` with `null`; jti added to JWT_DENYLIST |

### Idempotency

Workers KV `put` is an unconditional overwrite. Replaying `app.store.authorize` produces identical state (the merchant's tokens are simply rewritten). Replaying `app.updated` is also safe. `app.store.uninstalled` calls `delete`; deleting a non-existent key is a no-op in Workers KV.

### What is NOT stored

- The install URL JWT itself is **never persisted server-side** — it lives in the MCP client's connector settings, not in our KV. Only its `jti` (hashed) appears in the denylist when revoked.
- Webhook event payloads are never archived in KV. They are processed transactionally and discarded.
- No PII (email, phone, billing) is stored in `MerchantRecord`. If `merchant_id` is populated, it is the opaque Salla identifier only.

---

## Entity: RevokedJTI (JWT_DENYLIST entry)

Stored in `JWT_DENYLIST` under key `jti:{sha256(jti)}` where `sha256(jti)` is the lowercase hex SHA-256 of the JTI string.
Value: small JSON envelope (or just `"1"` for v1; structured value preferred for audit).
TTL: set to `(jwtExp - now + 60)` seconds so the entry auto-purges shortly after the JWT would have expired anyway.

```typescript
interface RevokedJTI {
  revoked_at: number;                      // Unix epoch ms
  reason: 'regenerated' | 'manual' | 'compromised' | 'uninstalled';
  store_id: string;                        // for audit and forensic lookup
}
```

```typescript
// KV write on revocation
const ttl = Math.max(60, Math.floor(jwtExp - Date.now() / 1000) + 60);
await env.JWT_DENYLIST.put(
  `jti:${await sha256Hex(jti)}`,
  JSON.stringify({ revoked_at: Date.now(), reason: 'regenerated', store_id }),
  { expirationTtl: ttl }
);
```

### Why the JTI is hashed

Storing the plaintext jti in KV would mean a KV dump reveals live revocation identifiers — useful only to attackers attempting to identify which JWTs were considered sensitive enough to revoke. Hashing the jti lets us look up "is this token revoked?" without storing recoverable token-identifying data. This also matches the security pattern documented in Cloudflare's `workers-oauth-provider`.

### Lifecycle

| Operation | Action |
|-----------|--------|
| Mint new install URL | Old `active_jti` (if any) added to denylist with TTL = old JWT exp - now + 60s |
| Revoke install URL (explicit) | jti added to denylist with TTL |
| JWT expired naturally | KV TTL auto-purges the entry; lookup naturally returns null |

`app.store.uninstalled` does NOT need to add anything to the denylist. The merchant record is deleted, so any subsequent tool call using a previously valid install URL will fail at the second KV read (no merchant record → 401) regardless of denylist state.

---

## Entity: InstallURLToken (JWT payload — not stored separately)

The install URL token is a signed HS256 JWT. It is not stored in KV; its `jti` claim is what gets stored (hashed) in the denylist when revoked. The JWT is self-describing and tamper-evident.

```typescript
interface InstallURLTokenPayload {
  iss: 'salla-mcp';                        // Issuer
  aud: 'salla-mcp';                        // Audience
  sub: string;                             // store_id — used to look up MerchantRecord
  store_id: string;                        // duplicate of sub for clarity in code
  jti: string;                             // crypto.randomUUID() — opaque revocation identifier
  iat: number;                             // Unix epoch seconds — issuance time
  exp: number;                             // Unix epoch seconds — iat + 90 days (configurable)
  scope: string[];                         // Minted scope ceiling — intersection applied at verification
  kid?: string;                            // Optional signing key version, for HS256 key rotation
}
```

**Scope ceiling**: Effective scopes for a request = `token.scope ∩ merchantRecord.scopes`. Computed in-memory after the two KV reads. No extra storage access. Per spec clarification 1, the snapshot is set at mint time and never changes; if the merchant later gains scopes in Salla, they do not flow through to existing URLs (a new URL must be minted). If the merchant loses scopes via `app.updated`, the intersection naturally contracts.

**JTI generation**: `crypto.randomUUID()` produces a 128-bit random v4 UUID. Globally unique by spec; never reused (FR-030).

---

## Transient Entity: RefreshLock

Stored in `SALLA_TOKENS` under key `refresh_lock:{store_id}`.
Value: `"1"` (presence flag; the value is irrelevant).
TTL: 30 seconds.

This is not a persistent entity — it exists only during an active token refresh operation.

```typescript
// Acquire lock
await env.SALLA_TOKENS.put(`refresh_lock:${storeId}`, '1', { expirationTtl: 30 });
// Release lock (on either success or failure)
await env.SALLA_TOKENS.delete(`refresh_lock:${storeId}`);
```

**Why this is critical:** the Salla docs are explicit that parallel refresh attempts are catastrophic — they invalidate the refresh token, revoke all access tokens obtained with it, and force the merchant to reinstall the app. The mutex below is the *only* mechanism preventing this. Salla offers no grace window on its side.

**Failure mode:** if the Worker crashes between acquiring the lock and completing the refresh, the lock auto-expires after 30 seconds. The next caller waits its 5×200ms backoff window, observes that the lock is still held (or the record hasn't advanced), and either gets the new token (if a third caller succeeded) or returns HTTP 502 to the MCP client. No risk of permanent merchant lockout from our side.

---

## KV Access Patterns

### Tool Call (Hot Path) — 2 reads, 0 writes

```
1. JWT_DENYLIST.get('jti:' + sha256(jti))      → null (not revoked) or value (401)
2. SALLA_TOKENS.get('store:' + storeId)        → decrypt → MerchantRecord
   [If access_expires_at - now < refreshWindow → trigger refresh sub-flow below]
3. Compute effectiveScopes = jwtScope ∩ record.scopes
4. Call Salla API with decrypted access_token
```

In steady state — i.e. the access token is not yet within the refresh window — only steps 1–4 execute. Two reads, zero writes.

### Token Refresh (Off Hot Path — ~once per 14 days per merchant)

Triggered when `access_expires_at - now < refreshWindow` (default 60 minutes).

```
A. SALLA_TOKENS.get('refresh_lock:' + storeId)
   - if present → enter wait path B
   - if absent → enter refresh path C

B. Wait path:
   - re-read 'store:' + storeId up to 5 times with 200ms backoff
   - if access_expires_at advances past refreshWindow during retries → use the now-current token, done
   - if no advance after 5 retries → return HTTP 502 to MCP client

C. Refresh path:
   1. SALLA_TOKENS.put('refresh_lock:' + storeId, '1', { expirationTtl: 30 })
   2. Re-read 'store:' + storeId   (defense against TOCTOU — another worker may have just finished)
      - if access_expires_at now > now + refreshWindow → release lock, use existing token
   3. POST https://accounts.salla.sa/oauth2/token with refresh_token
   4. On success:
      - encrypt new tokens with current key_version
      - move OLD refresh_token to previous_refresh_token_ct/iv (one cycle)
      - SALLA_TOKENS.put('store:' + storeId, encryptedRecord)
      - SALLA_TOKENS.delete('refresh_lock:' + storeId)
      - proceed with tool call
   5. On failure (4xx from Salla):
      - update record with status: 'refresh_failed'
      - SALLA_TOKENS.delete('refresh_lock:' + storeId)
      - return HTTP 401 to MCP client with re-install instruction (FR-021)
```

### Mint Install URL (Management — not hot path)

```
1. SALLA_TOKENS.get('store:' + storeId) → decrypt → get active_jti, oldExp
2. If active_jti non-null:
     ttl = max(60, oldExp - now/1000 + 60)
     JWT_DENYLIST.put('jti:' + sha256(active_jti), revokeRecord, { expirationTtl: ttl })
3. Generate new jti = crypto.randomUUID()
4. Sign new JWT with new jti (kid = current signing key version)
5. SALLA_TOKENS.put('store:' + storeId, encrypt({...record, active_jti: newJti, updated_at: now}))
6. Return signed install URL
```

### Revoke Install URL (Management — explicit)

```
1. SALLA_TOKENS.get('store:' + storeId) → decrypt → confirm active_jti matches request
2. ttl = max(60, jwtExp - now/1000 + 60)
3. JWT_DENYLIST.put('jti:' + sha256(jti), revokeRecord, { expirationTtl: ttl })
4. SALLA_TOKENS.put('store:' + storeId, encrypt({...record, active_jti: null, updated_at: now}))
```

If step 1 finds no merchant record, the revoke endpoint returns HTTP 404 per FR-029.

### App Uninstall (Webhook)

```
1. Verify HMAC signature
2. SALLA_TOKENS.delete('store:' + storeId)
3. Return HTTP 200 to Salla
```

No denylist write needed — the absence of the merchant record causes all subsequent tool calls using URLs from this merchant to fail at the second hot-path read.

---

## Crypto: AES-256-GCM with HKDF-Derived Per-Store Keys

All sensitive fields in `MerchantRecord` (`access_token_ct`, `refresh_token_ct`, `previous_refresh_token_ct`) are encrypted before being written to KV. Per-record encryption keys are derived from a versioned base secret using HKDF-SHA256 with the store ID as `info`.

```typescript
// src/lib/crypto.ts (sketch)

async function deriveKey(env: Env, storeId: string, version: number): Promise<CryptoKey> {
  const ikmB64 = env[`TOKEN_ENC_KEY_V${version}`];      // Worker secret
  const saltB64 = env.ENCRYPTION_SALT;                  // Worker secret, fixed per env
  const ikm = base64ToBytes(ikmB64);
  const salt = base64ToBytes(saltB64);
  const info = new TextEncoder().encode(`salla-mcp:store:${storeId}`);

  // HKDF-Extract + HKDF-Expand → 32 bytes
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptField(plaintext: string, env: Env, storeId: string, version: number) {
  const key = await deriveKey(env, storeId, version);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ct: bytesToBase64(new Uint8Array(ctBuf)), iv: bytesToBase64(iv) };
}

async function decryptField(ct: string, ivB64: string, env: Env, storeId: string, version: number) {
  const key = await deriveKey(env, storeId, version);
  const ptBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ct)
  );
  return new TextDecoder().decode(ptBuf);
}
```

### Properties

- **Each store has a different effective key.** A leak of one store's ciphertext + key derivation does not reveal others.
- **Keys never persisted in KV.** Only ciphertext + IV + key_version are in KV. The base secret is in Worker Secrets.
- **Key rotation is lazy.** Bump `ACTIVE_KEY_VERSION` and deploy. New writes use the new key. Reads dispatch on the stored `key_version`. As records refresh naturally (~14 days), they re-encrypt with the new version. Old `TOKEN_ENC_KEY_V{n}` remains in Worker Secrets until all records are confirmed migrated, then deleted.
- **Plaintext tokens never exist outside the in-memory scope of a single request** (constitution principle 4).

### Threat model

| Adversary | Outcome |
|---|---|
| Read access to KV only | Sees ciphertext only. Cannot decrypt without Worker Secrets. |
| Read access to Worker Secrets only | Has the base key but no ciphertext. Cannot decrypt anything they can't already see in transit. |
| Both | Can decrypt all merchant records. This is the equivalent of full deploy access; encryption alone cannot defend against this — controls are at the account/RBAC layer. |
| Network interceptor | Sees TLS-protected traffic only. No tokens in URLs or query parameters by design (FR-011 prefers Authorization header). |

---

## State Transitions

### MerchantRecord

```
[not installed]
      │
   app.store.authorize
      │
      ▼
  [active] ◄──── app.updated (overwrite tokens + scopes)
      │
      │  refresh failure (Salla rejects refresh_token)
      │
      ▼
  [refresh_failed] ─── (merchant must reinstall) ───► app.store.authorize ──► [active]
      │
      │
   app.store.uninstalled
      │
      ▼
[not installed]
```

### InstallURL (logical state, encoded across MerchantRecord.active_jti and JWT_DENYLIST)

```
         mint()
  ┌───────────────────────────────┐
  │                               ▼
[none] ──mint()──► [active: jti=A]
                        │
                        ├─── mint() (new URL)         ──► A added to denylist; new jti=B becomes active
                        ├─── revoke()                 ──► A added to denylist; active_jti = null
                        └─── app.store.uninstalled    ──► merchant record deleted (denylist no-op)
                                  │
                                  ▼
                               [revoked]
                                  │
                          (JWT exp passes, KV TTL)
                                  │
                                  ▼
                                [gone]
```

When a merchant uninstalls, no explicit InstallURL state transition is required. The `MerchantRecord` is deleted; subsequent requests fail at step 2 of the hot path (no merchant record → 401) without needing a denylist entry.

---

## Scope Definitions (Canonical — confirm strings against Salla developer portal)

```typescript
// src/constants.ts
export const TOOL_SCOPE_MAP: Record<string, string[]> = {
  list_orders:           ['orders:read'],
  get_order:             ['orders:read'],
  update_order_status:   ['orders:write'],
  search_catalog:        ['products:read'],
  get_inventory_levels:  ['products:read'],   // or 'inventory:read' — confirm against Salla scope list
  get_shipment_tracking: ['shipments:read'],  // confirm exact scope string
  whoami:                [],                  // always available; no scope required
};
```

⚠️ Scope string values above are assumed and unverified. The Salla docs at `https://docs.salla.dev/421118m0` reference scope setup but do not enumerate string identifiers. See **Implementation prerequisites** in `plan.md` — confirm against the Salla Partners Portal scope picker before implementing `src/constants.ts`. The `Store Scopes` API endpoints (`https://docs.salla.dev/15104922e0`, `https://docs.salla.dev/15107150e0`) may help enumerate them programmatically.

---

## Environment Bindings (`wrangler.toml`)

```toml
[[kv_namespaces]]
binding = "SALLA_TOKENS"
id = "..."

[[kv_namespaces]]
binding = "JWT_DENYLIST"
id = "..."

[[unsafe.bindings]]
name = "RATE_LIMITER"
type = "ratelimit"
namespace_id = "..."
simple = { limit = 60, period = 60 }
```

**Worker Secrets** (set via `wrangler secret put`):

| Secret name | Description |
|-------------|-------------|
| `TOKEN_ENC_KEY_V1` | Base64-encoded 32-byte HKDF base key (rotatable; older versions retained until lazy migration completes) |
| `ENCRYPTION_SALT` | Base64-encoded 16-byte salt for HKDF (fixed per environment; rotation requires re-encryption of all records) |
| `JWT_SIGNING_SECRET` | Base64-encoded HMAC-SHA256 key for install URL JWTs (HS256) |
| `SALLA_WEBHOOK_SECRET` | HMAC key for Salla webhook signature verification (algorithm and header name TBC against Salla docs) |
| `INTERNAL_API_SECRET` | Pre-shared HMAC key for Dashboard → internal mint/revoke calls |
| `SALLA_CLIENT_ID` | Salla app client ID — used for `/oauth2/token` refresh calls |
| `SALLA_CLIENT_SECRET` | Salla app client secret — used for `/oauth2/token` refresh calls |
| `ACTIVE_KEY_VERSION` | Plain integer string ("1", "2"...) indicating the current encryption key version for new writes |

`.dev.vars` (gitignored) holds local development equivalents of all of the above.
