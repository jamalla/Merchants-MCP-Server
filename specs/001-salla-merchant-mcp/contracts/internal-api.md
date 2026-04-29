# Contract: Internal API (Dashboard → MCP Server)

**Caller**: Salla Dashboard backend (server-to-server only)
**Authentication**: HMAC-SHA256 over request body and timestamp, with replay protection
**Network**: SHOULD additionally be restricted to Salla's internal network or an allowlisted IP range; HMAC alone is the contract guarantee

---

## Authentication

All `/internal/*` endpoints require **two headers** computed by the caller:

| Header | Value |
|---|---|
| `X-Salla-Internal-Auth` | Hex-encoded HMAC-SHA256 over `{timestamp}.{rawBody}` using `INTERNAL_API_SECRET` |
| `X-Salla-Internal-Timestamp` | Unix seconds at the time the request was signed |

```
hmac        = HMAC-SHA256(INTERNAL_API_SECRET, timestamp + "." + rawBodyBytes)
authHeader  = lowercaseHexEncode(hmac)
```

The Worker `middleware/auth-internal.ts` validates incoming requests:

1. Both headers MUST be present. Missing → HTTP 401.
2. Timestamp MUST be within ±300 seconds of the Worker's current time. Otherwise → HTTP 401 (replay window guard).
3. Recompute the HMAC over `{timestamp}.{rawBody}` using `INTERNAL_API_SECRET` and compare to the header value using a constant-time comparison. Mismatch → HTTP 401.
4. On any failure: log WARN with no body or header values, return `{"error": "unauthorized"}`.

### Why HMAC-with-timestamp instead of static Bearer

A static `Authorization: Bearer <secret>` would put the shared secret on every request in plaintext. Anything that logs request headers would leak it; rotation requires synchronized cutover; and replays are unbounded. HMAC-over-body means the secret never appears in the request, replays are bounded by the timestamp window, and rotation can use versioned keys (see below) without coordinated cutover.

### Secret rotation

`INTERNAL_API_SECRET_V{n}` are stored in Worker Secrets. The Worker tries each version in priority order until one validates the HMAC. After the Dashboard cuts over to a new version, the old secret can be retired by removing it from Worker Secrets. No downtime required.

---

## POST /internal/mint

Mints a new signed install URL for a given merchant store. Atomically revokes the previous active install URL for that store (if any). Per FR-008 and v1 product policy, each merchant has at most one active URL at a time.

**Request**:
```http
POST /internal/mint
X-Salla-Internal-Auth: 9f4c2a...
X-Salla-Internal-Timestamp: 1761779423
Content-Type: application/json

{
  "store_id": "12345",
  "scopes": ["orders:read", "products:read"],
  "lifetime_seconds": 7776000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `store_id` | string | yes | Salla store identifier |
| `scopes` | string[] | yes | Scope ceiling for this install URL — MUST be a subset of the merchant's currently granted Salla scopes |
| `lifetime_seconds` | integer | no | JWT lifetime in seconds; defaults to 7,776,000 (90 days); maximum 7,776,000 |

**Success response** (HTTP 200):
```json
{
  "install_url": "https://mcp.salla.dev/v1/mcp?token=eyJ...",
  "jti": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "expires_at": 1769555423
}
```

| Field | Description |
|-------|-------------|
| `install_url` | Complete URL the merchant pastes into their MCP client |
| `jti` | Opaque revocation identifier — the Dashboard SHOULD persist this to enable future revocation |
| `expires_at` | Unix epoch seconds at which the JWT will expire |

**Error responses**:

| Scenario | HTTP | Body |
|----------|------|------|
| Missing or invalid HMAC headers | 401 | `{"error": "unauthorized"}` |
| Timestamp outside ±300s window | 401 | `{"error": "unauthorized"}` |
| Unknown `store_id` (no MerchantRecord exists) | 404 | `{"error": "store_not_found"}` |
| `scopes` is not a subset of the merchant's granted Salla scopes | 400 | `{"error": "invalid_scopes", "detail": "Requested scopes exceed merchant grant"}` |
| `lifetime_seconds` exceeds maximum | 400 | `{"error": "invalid_lifetime"}` |
| Validation error (missing field, bad type) | 400 | `{"error": "invalid_request", "detail": "..."}` |

The `invalid_scopes` check is defense-in-depth. Even though the runtime intersection (`jwtScopes ∩ liveSallaScopes`) would clamp the effective set anyway, surfacing this error loudly catches Dashboard bugs early.

**Side effects** (in order):
1. Read `SALLA_TOKENS` key `store:{store_id}`. If absent → return 404.
2. Verify `requested_scopes ⊆ merchantRecord.scopes`. If not → return 400.
3. If `merchantRecord.active_jti` is non-null:
   - Compute the old JWT's remaining TTL.
   - Write `JWT_DENYLIST` key `jti:{sha256(active_jti)}` with TTL `(oldExp - now + 60)` seconds.
4. Generate new `jti = crypto.randomUUID()`.
5. Sign new JWT with `JWT_SIGNING_SECRET` (HS256, includes `kid` for signing-key rotation).
6. Re-encrypt the merchant record with the current `key_version`, set `active_jti = newJti`, `updated_at = now`. Write to `SALLA_TOKENS` key `store:{store_id}`.
7. Return the install URL.

Steps 3–6 are not transactionally atomic (Workers KV limitation). The race window is microseconds; the old JTI is written to the denylist *before* the new URL is returned to the Dashboard, so concurrent tool calls cannot continue using the old URL by the time the Dashboard hands the new URL to the merchant.

---

## POST /internal/revoke

Revokes a specific install URL by its opaque JTI. Takes effect immediately.

**Request**:
```http
POST /internal/revoke
X-Salla-Internal-Auth: 9f4c2a...
X-Salla-Internal-Timestamp: 1761779423
Content-Type: application/json

{
  "store_id": "12345",
  "jti": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `store_id` | string | yes | Merchant store identifier |
| `jti` | string | yes | Opaque revocation identifier returned by `/internal/mint` |

**Success response — JTI was the active URL and is now revoked** (HTTP 200):
```json
{ "revoked": true, "reason": "revoked" }
```

**Success response — JTI was not the active URL (already superseded by a previous mint, or already revoked)** (HTTP 200):
```json
{ "revoked": false, "reason": "already_revoked" }
```

This is the success-equivalent path for the "Regenerate" UX: if the Dashboard fires duplicate revoke requests, or revokes a JTI that was already superseded by a subsequent mint, the operation is a no-op and the response acknowledges that. In both cases the Dashboard can treat the operation as complete.

**Error responses**:

| Scenario | HTTP | Body |
|----------|------|------|
| Missing or invalid HMAC headers | 401 | `{"error": "unauthorized"}` |
| Timestamp outside ±300s window | 401 | `{"error": "unauthorized"}` |
| `store_id` not found | 404 | `{"error": "store_not_found"}` |
| Validation error (missing field, bad type) | 400 | `{"error": "invalid_request", "detail": "..."}` |

**Side effects**:
1. Read `SALLA_TOKENS` key `store:{store_id}`.
   - If absent → return 404.
2. Compute the JWT's remaining TTL from the request (the Worker can re-derive this from the JTI's known issuance metadata, or use a conservative default of the maximum lifetime, 90 days).
3. Write `JWT_DENYLIST` key `jti:{sha256(jti)}` with TTL `(jwtExp - now + 60)` seconds.
4. If the requested JTI matches `merchantRecord.active_jti`:
   - Set `active_jti = null`, `updated_at = now`. Re-encrypt and write back.
   - Return `{"revoked": true, "reason": "revoked"}`.
5. Otherwise (JTI was already not the active one):
   - Do not modify the merchant record (the previous mint flow already handled denylist insertion when it superseded this JTI).
   - Return `{"revoked": false, "reason": "already_revoked"}`.

The denylist write at step 3 happens regardless of whether the JTI was active. This is belt-and-braces: even in pathological cases where the JTI is somehow not on the denylist already, this revoke call ensures it ends up there.

---

## Rate Limiting on Internal Endpoints

Internal endpoints are exempt from the per-install-URL rate limiter (FR-031 in spec). They are called infrequently (only when a merchant generates or revokes a URL) and are protected by HMAC authentication. The Dashboard backend is responsible for its own abuse prevention against its own users.

The Worker MAY apply a coarse global rate limit on `/internal/*` (e.g., 100 req/s across all callers) as a defense against runaway loops on the Dashboard side. This is implementation discretion and not part of the contract.

---

## Logging Contract

For each `/internal/*` call, the Worker emits one structured log entry on completion:

```json
{
  "ts": 1761779423521,
  "level": "info",
  "event": "internal_api",
  "endpoint": "mint",
  "store_id": "12345",
  "jti": "a1b2...",
  "status_code": 200,
  "latency_ms": 14
}
```

Allowed fields per constitution principle 5: `store_id`, `jti`, `endpoint`, `status_code`, `latency_ms`, `event`, `level`, `ts`, `request_id`. Forbidden in any log entry: `INTERNAL_API_SECRET`, the HMAC value, request body contents, scope arrays (which can leak Dashboard intent), or any token value.

---

## Error Response Format

All errors follow the same shape:
```json
{
  "error": "<machine_readable_code>",
  "detail": "<human readable, optional>"
}
```

`error` codes used by this contract:

| Code | HTTP | Meaning |
|------|------|---------|
| `unauthorized` | 401 | HMAC headers missing/invalid or timestamp outside window |
| `invalid_request` | 400 | Body is not valid JSON or missing required fields |
| `invalid_scopes` | 400 | Mint requested scopes exceed merchant's granted scopes |
| `invalid_lifetime` | 400 | `lifetime_seconds` exceeds the configured maximum |
| `store_not_found` | 404 | No `MerchantRecord` exists for the requested `store_id` |

No merchant data, tokens, or internal state appears in error responses (FR-017, FR-026).
