# Contract: Salla Webhook Receiver

**Endpoint**: `POST /webhooks/salla`
**Caller**: Salla Hydra (Easy Mode OAuth push)
**Authentication**: HMAC-SHA256 signature verification (mandatory before any processing)

⚠️ **Several details on this page are unverified against an actual Salla webhook capture.** They are derived from the Salla docs at `https://docs.salla.dev/421118m0` (Authorization), `https://docs.salla.dev/421119m0` (Webhooks), `https://docs.salla.dev/433811m0` (Store events), and the public knowledge that webhook events appear under `https://docs.salla.dev/doc-421413`. Where this contract documents a field name, header name, or path that the docs did not unambiguously confirm, it is flagged with `🟡 unverified`. These MUST be confirmed by capturing a real webhook from a Salla demo store before implementation of `webhooks/salla.ts`. Do not let `/speckit.implement` invent values silently.

---

## Signature Verification

Every inbound request MUST be verified before any state change occurs (FR-002, constitution principle 8).

```
Algorithm:   HMAC-SHA256
Key:         SALLA_WEBHOOK_SECRET_V{n} (Worker Secret; supports rotation)
Signed over: Raw request body bytes
```

🟡 **unverified** — confirm against Salla docs / webhook capture:
- Exact header name carrying the signature (commonly `X-Salla-Signature` or similar)
- Signature encoding format (raw hex, prefixed `sha256={hex}`, base64, etc.)

**Verification logic** (sketch):
```typescript
const sig = req.headers.get('X-Salla-Signature');                // confirm header name
const body = await req.arrayBuffer();
let valid = false;
for (const version of activeWebhookSecretVersions(env)) {       // try V1, V2... in priority order
  const expected = await hmacSha256Hex(secretFor(env, version), body);
  if (timingSafeEqual(sig, expected)) { valid = true; break; }
}
if (!valid) {
  return new Response(null, { status: 403 });
}
```

Timing-safe comparison is required. On invalid signature: HTTP 403, no state change, no log of request body, log entry contains only the (truncated) header and request_id.

### Webhook secret rotation

`SALLA_WEBHOOK_SECRET_V1`, `SALLA_WEBHOOK_SECRET_V2`, etc. are stored in Worker Secrets. The verifier tries each version until one matches. After Salla cuts over to a new secret, the old version can be retired by removing it from Worker Secrets. No downtime.

---

## Common Payload Shape

🟡 **unverified field paths** — Salla docs do not publish a definitive webhook payload schema in the Authorization page. The structure below is the working assumption derived from third-party samples and the Easy Mode tutorial; capture a real webhook before writing parsing code.

```json
{
  "event": "<event-name>",
  "merchant": "<merchant-or-store-identifier>",
  "data": { ... event-specific ... }
}
```

🟡 **unverified** — relationship between `merchant` and `store_id`:
- The Salla User Info endpoint (`https://accounts.salla.sa/oauth2/user/info`) returns separate merchant and store details; these may be different identifiers.
- The webhook payload may include `merchant`, `store_id`, both, or one nested inside the other.
- Implementation MUST capture an actual webhook to determine the field path that yields the value used as a KV key (`store:{store_id}` per data-model.md).

---

## Event: `app.store.authorize`

Sent by Salla when a merchant installs the MCP app from the App Store. Carries the OAuth access token and refresh token.

🟡 **unverified payload shape** — illustrative only:
```json
{
  "event": "app.store.authorize",
  "merchant": "<store-or-merchant-id>",
  "data": {
    "access_token": "<salla-access-token>",
    "refresh_token": "<salla-refresh-token>",
    "expires": 1769555423,
    "scope": "orders.read products.read"
  }
}
```

### Critical: `expires` field semantics

Per the Salla docs at `https://docs.salla.dev/421118m0`:

> *"The `expires` variable is returned as a unix timestamp value for the app event `app.store.authorize`."*

**`expires` in this webhook is an ABSOLUTE Unix timestamp**, NOT a duration. The handler must treat it as a wall-clock value, not as `now + expires`. This is different from the response of `https://accounts.salla.sa/oauth2/token` (used during refresh), where `expires` is a duration in seconds. The two code paths (`webhooks/salla.ts` and `lib/refresh.ts`) MUST NOT share parsing logic.

**Conversion**:
```typescript
// in webhooks/salla.ts
const accessExpiresAtMs = data.expires * 1000;  // Unix ts seconds → ms

// in lib/refresh.ts
const accessExpiresAtMs = Date.now() + tokenResp.expires * 1000;  // duration seconds → ms
```

Mixing these up will cause every refresh window check to be wildly wrong (off by ~14 days in either direction).

### Handler behavior

1. Verify HMAC signature (see above). On failure → 403, return.
2. Parse the event payload. Extract `storeId` from the verified merchant/store field path (🟡 path TBC).
3. Read existing `SALLA_TOKENS` key `store:{storeId}`:
   - If absent → this is a fresh install. Set `installed_at = now`.
   - If present → preserve `installed_at` from existing record.
4. **Replay/reorder protection (FR-006 strict idempotency):**
   - Compute incoming `accessExpiresAtMs = data.expires * 1000`.
   - If a record exists and `accessExpiresAtMs <= existingRecord.access_expires_at`, the incoming event is older than what we already have. Return HTTP 200 with no state change. Log a WARN with `event=replay_ignored`.
   - This guards against Salla's at-least-once retries delivering events out of order.
5. Build new `MerchantRecord`:
   - `store_id` = parsed
   - `scopes` = parse `data.scope` (🟡 confirm: space-separated string vs. array)
   - `access_token`, `refresh_token` = encrypted with current `key_version`, fresh IVs
   - `access_expires_at` = `accessExpiresAtMs`
   - `refresh_expires_at` = `now + 30 * 24 * 3600 * 1000` (Salla docs say refresh tokens last 1 month)
   - `previous_refresh_token_*` = absent
   - `active_jti` = preserved from existing record (or null on fresh install)
   - `installed_at` = preserved or now
   - `updated_at` = now
   - `key_version` = current ACTIVE_KEY_VERSION
   - `status = "active"`
   - `schema_version = 1`
6. Encrypt and write to `SALLA_TOKENS` key `store:{storeId}`.
7. Return HTTP 200.

---

## Event: `app.updated`

Sent by Salla when a merchant updates the app (changes scopes, etc.). 🟡 **Behavior under verification.**

Per the Salla docs:

> *"In the easy mode, when the Merchant updates the app, Salla sends you the `app.updated` event. After that, Salla sends you the `app store.authorized` event, which provides you with the new access token and refresh token."*

This implies `app.updated` is a **notification only** — the new tokens arrive in a *subsequent* `app.store.authorize` event. If that interpretation is correct:

### Handler behavior (notification-only model)

1. Verify HMAC signature. On failure → 403, return.
2. Parse payload. Extract `storeId`.
3. Read existing `SALLA_TOKENS` key `store:{storeId}`. If absent → log WARN and return 200 (Salla will follow up with `app.store.authorize`).
4. Optionally update `updated_at` to `now` for audit purposes. Do NOT modify tokens, scopes, or expiry — those will be replaced by the upcoming `app.store.authorize`.
5. Return HTTP 200.

🟡 **If empirical webhook captures show that `app.updated` DOES carry the new tokens** (i.e., the docs' description is misleading and `app.updated` is actually self-sufficient), revert to the same handling as `app.store.authorize` minus the `installed_at` initialization. The implementation team MUST verify against a real Salla webhook before choosing.

### Idempotency

Pure notification: no state change → trivially idempotent.

If `app.updated` does carry tokens, the same replay/reorder protection from the `app.store.authorize` handler applies.

---

## Event: `app.store.uninstalled`

Sent by Salla when a merchant uninstalls the MCP app from the App Store.

🟡 **unverified event name** — confirm against `https://docs.salla.dev/433811m0` (Store events). Possible alternates: `app.uninstalled`, `app.store.uninstall`. The exact string matters because the dispatcher branches on it.

🟡 **unverified payload shape** — illustrative only:
```json
{
  "event": "app.store.uninstalled",
  "merchant": "<store-or-merchant-id>",
  "data": {}
}
```

### Handler behavior

1. Verify HMAC signature. On failure → 403, return.
2. Parse payload. Extract `storeId`.
3. `env.SALLA_TOKENS.delete('store:' + storeId)` — remove the merchant's record entirely.
4. No write to `JWT_DENYLIST` is needed — the absence of the merchant record causes any subsequent tool call using a previously valid install URL to fail at the second hot-path read with HTTP 401.
5. Return HTTP 200.

### Idempotency

`delete` on a missing KV key is a no-op in Workers KV. Safe to replay.

---

## Unknown Events

If the `event` field does not match any known handler:

1. Log WARN with `event=unknown_webhook_event`, `event_name={raw}`, `request_id={...}`. Do NOT log the body.
2. Return HTTP 200 with empty body.

The 200 prevents Salla from retrying on event names it adds in the future that we haven't implemented yet. The WARN log ensures we notice when a new event type starts arriving so we can decide whether to handle it.

---

## Response Codes

| Scenario | HTTP Status | Salla retry behavior |
|----------|-------------|----------------------|
| Signature valid, event processed | 200 | No retry |
| Signature valid, event ignored as replay | 200 | No retry |
| Signature valid, unknown event name | 200 | No retry |
| Signature invalid or missing | 403 | Salla will retry (this is a Salla-side problem, not ours; we should not 200 it) |
| Internal error during processing | 500 | Salla retries (deduped by replay protection above) |

Salla's at-least-once delivery means the server will retry on non-2xx responses. Our `200` on unknown events and on replays prevents retry storms while still giving us audit logs of unhandled cases.

---

## Logging Contract

For each webhook request, the Worker emits one structured log entry on completion:

```json
{
  "ts": 1761779423521,
  "level": "info",
  "event": "salla_webhook",
  "webhook_event": "app.store.authorize",
  "store_id": "12345",
  "status_code": 200,
  "latency_ms": 22,
  "outcome": "stored" | "replay_ignored" | "unknown_event" | "signature_invalid",
  "request_id": "..."
}
```

Allowed fields per constitution principle 5: `store_id`, `webhook_event`, `outcome`, `status_code`, `latency_ms`, `event`, `level`, `ts`, `request_id`. Forbidden in any log entry: `SALLA_WEBHOOK_SECRET`, the signature header value, the request body, any token value, `merchant_id` PII.

---

## Implementation Prerequisites (collected `🟡 unverified` items)

The following MUST be confirmed before implementing `webhooks/salla.ts`. Capture a real webhook from a Salla demo store install:

1. **Signature header name** — likely `X-Salla-Signature`, but confirm.
2. **Signature encoding** — raw hex, `sha256={hex}` prefixed, or base64.
3. **Webhook payload top-level shape** — `{event, merchant, data}` is the working assumption.
4. **`store_id` field path** — under `merchant`, `data.store.id`, both, or elsewhere.
5. **`scope` format** — space-separated string vs. JSON array.
6. **`app.updated` semantics** — pure notification (docs imply this) vs. carries tokens.
7. **Exact uninstall event name** — `app.store.uninstalled` vs. alternates.
8. **Store events list** — verify against `https://docs.salla.dev/433811m0` for the canonical event name catalog.

Until these are verified, the handler scaffolding can be written, but every parse step must defensively check for the field's presence and log structured WARN entries when assumptions don't match the actual payload.
