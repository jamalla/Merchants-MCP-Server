# Phase 0 Research: Salla Merchant MCP Server

**Date**: 2026-04-29  
**Branch**: `001-salla-merchant-mcp`

## Summary

The project constitution locks the full stack (Workers, Hono, MCP SDK, Zod, KV, TypeScript strict). No technology unknowns remain. Research below documents resolved decisions and the Salla API specifics that must be confirmed against the Salla developer portal before implementing `lib/salla-client.ts` and `webhooks/salla.ts`.

---

## Decision 1: Runtime & Framework

**Decision**: Cloudflare Workers + Hono  
**Rationale**: Constitution-mandated. Workers gives sub-millisecond cold starts, global edge distribution, built-in WebCrypto, Workers KV, and the Rate Limiting binding — all required by the spec. Hono is the lightest full-featured router for Workers with excellent TypeScript support.  
**Alternatives considered**: None — constitution mandates this combination.

---

## Decision 2: MCP Protocol Transport

**Decision**: @modelcontextprotocol/sdk Streamable HTTP in stateless mode  
**Rationale**: Constitution-mandated. Stateless mode means no session IDs, no SSE, no Durable Objects. Each request creates a fresh `McpServer` instance, dispatches one method, returns one JSON response.  
**Key implementation note**: The MCP SDK's `StreamableHTTPServerTransport` should be instantiated with `sessionIdGenerator: undefined` to disable session management. The MCP endpoint accepts both `POST /v1/mcp` (tool calls, initialize) and `GET /v1/mcp` (some clients use GET for initialize).  
**Alternatives considered**: SSE transport (out of scope per spec and constitution), stdio (separate future repo).

---

## Decision 3: JWT Signing for Install URLs

**Decision**: HS256 (HMAC-SHA256) using `crypto.subtle` (WebCrypto, built into Workers)  
**Rationale**: No external JWT library needed — Workers has native WebCrypto. HS256 is sufficient for server-to-server tokens where the signing and verification happen in the same codebase. The signing secret (`JWT_SIGNING_SECRET`) lives in Worker Secrets.  
**JWT payload shape**:
```json
{
  "iss": "salla-mcp",
  "aud": "salla-mcp",
  "sub": "{storeId}",
  "jti": "{crypto.randomUUID()}",
  "iat": 1234567890,
  "exp": 1234567890,
  "scope": ["orders:read", "products:read"]
}
```
**Alternatives considered**: RS256 (asymmetric — overkill for internal tokens, requires key-pair management), using a JWT library (adds bundle size with no benefit in Workers environment).

---

## Decision 4: Token Encryption

**Decision**: AES-256-GCM via WebCrypto; encryption key in Worker Secret `ENCRYPTION_KEY` (base64-encoded 32-byte key)  
**Rationale**: Constitution-mandated. AES-GCM provides authenticated encryption — both confidentiality and integrity. The 96-bit random IV is prepended to the ciphertext (base64-encoded together) in KV.  
**Storage format**: `base64(iv) + "." + base64(ciphertext+authTag)` — stored as a UTF-8 string in KV.  
**Alternatives considered**: AES-CBC (no authentication tag — rejected), envelope encryption with a KMS (adds latency and complexity — deferred to future if compliance requires it).

---

## Decision 5: Refresh Lock Mechanism

**Decision**: Best-effort KV lock key (`refresh_lock:{storeId}`) with 30-second TTL, combined with Salla's refresh-token grace window  
**Rationale**: Workers KV has no Compare-And-Swap. True distributed mutexes require Durable Objects, which are out of scope. The KV-lock approach is sufficient because: (a) concurrent refreshes for the same store are extremely rare (only during a 60-minute window every ~14 days), and (b) Salla's refresh-token grace window means even if two refreshes slip through simultaneously, the second one either succeeds (grace window) or fails gracefully (FR-021 path).  
**Alternatives considered**: Durable Objects (out of scope per spec/constitution), no lock at all (violates FR-019 and constitution principle 7).

---

## Decision 6: Scope Ceiling Storage

**Decision**: JWT `scope` claim carries the ceiling inline; no extra KV read at verification time  
**Rationale**: The minted scope set is embedded in the signed JWT (clarification Q1, 2026-04-29). Since the JWT is tamper-evident (HS256 signature), the scope ceiling is trustworthy without a KV lookup. This preserves the 2-KV-reads-per-tool-call guarantee (SC-006).  
**Alternatives considered**: Separate `InstallURL` KV record (extra read — rejected to preserve SC-006), storing scope in the JWT_DENYLIST record (complicates revocation logic).

---

## Decision 7: One-per-Merchant Atomicity

**Decision**: Store `active_jti` inside the encrypted `MerchantRecord`; on mint, read → denylist old JTI → write new `active_jti`  
**Rationale**: Workers KV has no transactions. Storing `active_jti` in the merchant record avoids a separate index. The mint sequence (read → denylist write → merchant write) has a microsecond race window; consequences are benign because the denylist write completes before the new URL is returned.  
**Alternatives considered**: Separate `active_jti:{storeId}` KV key (adds a third namespace, third read during mint), trusting the JWT exp alone without a denylist (can't support immediate revocation).

---

## Salla API Specifics — MUST CONFIRM BEFORE IMPLEMENTATION

The following details were not available from public documentation during Phase 0. They **must be confirmed against the [Salla Developer Portal](https://developer.salla.dev)** before implementing `webhooks/salla.ts` and `lib/salla-client.ts`. The spec's Assumptions section explicitly defers scope string names to implementation time.

### S1. Webhook Signature Verification

| Detail | Status | Notes |
|--------|--------|-------|
| Signature algorithm | Confirmed: HMAC-SHA256 (FR-002) | |
| Signature header name | **NEEDS CONFIRMATION** | Common: `X-Salla-Signature` or `Authorization` |
| Signed content | **NEEDS CONFIRMATION** | Typically raw request body bytes |
| HMAC key source | Confirmed: `SALLA_WEBHOOK_SECRET` Worker Secret (Assumptions) | |
| Signature format | **NEEDS CONFIRMATION** | Hex string? `sha256={hex}`? |

### S2. Easy Mode OAuth Token Payload

| Detail | Status | Notes |
|--------|--------|-------|
| Webhook event name (install) | Confirmed: `app.store.authorize` (User Story 1) | |
| Webhook event name (update) | Confirmed: `app.updated` | |
| Webhook event name (uninstall) | Confirmed: `app.store.uninstalled` | |
| `access_token` field name | **NEEDS CONFIRMATION** | Likely `access_token` |
| `refresh_token` field name | **NEEDS CONFIRMATION** | Likely `refresh_token` |
| `expires_in` field / format | **NEEDS CONFIRMATION** | Seconds from now, or absolute timestamp? |
| `scope` field / format | **NEEDS CONFIRMATION** | Space-separated string? Array? |
| `merchant_id` / `store_id` field | **NEEDS CONFIRMATION** | Need the exact field name for KV key |
| Access token lifetime | ~14 days per spec (User Story 5) — confirm exact value | |

### S3. Salla API Base URL and Auth Header

| Detail | Status | Notes |
|--------|--------|-------|
| Base URL | **NEEDS CONFIRMATION** | Likely `https://api.salla.dev/admin/v2/` |
| Auth header | **NEEDS CONFIRMATION** | Likely `Authorization: Bearer {access_token}` |
| API version prefix | **NEEDS CONFIRMATION** | v1 vs v2 |

### S4. Endpoint Paths for the Six Tools

| Tool | Endpoint | Status |
|------|----------|--------|
| `list_orders` | `GET /orders` (with query params) | **NEEDS CONFIRMATION** |
| `get_order` | `GET /orders/{id}` | **NEEDS CONFIRMATION** |
| `update_order_status` | `PUT /orders/{id}/status` or `PATCH /orders/{id}` | **NEEDS CONFIRMATION** |
| `search_catalog` | `GET /products` (with search params) | **NEEDS CONFIRMATION** |
| `get_inventory_levels` | `GET /products/availability` or similar | **NEEDS CONFIRMATION** |
| `get_shipment_tracking` | `GET /shipments/{id}` or `GET /orders/{id}/shipments` | **NEEDS CONFIRMATION** |

### S5. Salla OAuth Scope Strings

| Tool capability | Scope string (NEEDS CONFIRMATION) | Assumed format |
|-----------------|----------------------------------|---------------|
| Read orders | `orders:read` (assumed) | Confirm exact string |
| Write/update orders | `orders:write` (assumed) | Confirm exact string |
| Read products/catalog | `products:read` (assumed) | Confirm exact string |
| Read inventory | `products:read` or `inventory:read` | Confirm exact string |
| Read shipments | `shipments:read` (assumed) | Confirm exact string |

**Action**: Before writing `src/constants.ts` (scope map) and `src/lib/salla-client.ts`, a developer must log into the Salla Partner Portal, inspect the installed app's webhook payload, and cross-reference the API reference at [developer.salla.dev](https://developer.salla.dev).

---

## T006a-f: Salla Integration Verification (Best-Effort from Public Docs)

*Recorded: 2026-04-29. Direct portal access was not available. Findings below are derived from the Salla public documentation at https://docs.salla.dev and widely-referenced community resources. Each item marked 🟡 UNVERIFIED must be confirmed against a real webhook capture before the corresponding handler is considered production-ready.*

### T006a: app.store.authorize Webhook

**Signature header name**: `Authorization` with value `Bearer {hmac_hex}` — *🟡 UNVERIFIED, also commonly seen as `X-Salla-Signature`*. Implementation uses `X-Salla-Signature` as the working assumption (matches the contracts/webhooks.md assumption); must confirm via real capture.

**Signature encoding**: Raw lowercase hex HMAC-SHA256 over the raw request body bytes. *🟡 UNVERIFIED — may be `sha256={hex}` prefix format.*

**Payload top-level shape** (from public Salla docs and community samples):
```json
{
  "event": "app.store.authorize",
  "merchant": 12345,
  "data": {
    "access_token": "...",
    "refresh_token": "...",
    "expires": 1769555423,
    "scope": "offline_access basic_merchant orders.read_write products.read_write"
  }
}
```

**store_id field path**: `payload.merchant` — the top-level `merchant` field is a numeric store/merchant ID. *🟡 UNVERIFIED — may be `payload.data.merchant_id` or `payload.merchant_id` in some versions.*

**Working assumption for implementation**: `storeId = String(payload.merchant)`.

**`expires` field**: Absolute Unix timestamp (seconds) per Salla docs quote in contracts/webhooks.md. Confirmed interpretation: `accessExpiresAtMs = data.expires * 1000`. Do NOT add to `Date.now()`.

**`scope` format**: Space-separated string. *🟡 UNVERIFIED — may be dot-separated (`orders.read_write`) rather than colon-separated (`orders:read`). The implementation normalizes on parse.*

**Access token lifetime**: ~14 days (per spec). Salla docs reference 14-day access token lifetime for Easy Mode.

**Refresh token lifetime**: 30 days (per contracts/webhooks.md citing Salla docs).

### T006b: app.updated Webhook

**Event name**: `app.updated` — *🟡 UNVERIFIED, confirmed by spec but not via live capture.*

**Handler model decision**: **Notification-only**. Per Salla docs: "Salla sends you the `app.updated` event. After that, Salla sends you the `app.store.authorize` event." Implementation treats `app.updated` as a notification-only event — no token fields are parsed or stored. The subsequent `app.store.authorize` event carries new tokens.

*🟡 IF empirical capture shows `app.updated` carries tokens, the handler must be upgraded to match `app.store.authorize` handling (minus `installed_at` initialization).*

### T006c: app.store.uninstalled Webhook

**Event name**: `app.store.uninstalled` — *🟡 UNVERIFIED. Alternative event names seen in community: `app.uninstalled`. Check https://docs.salla.dev/433811m0 for canonical list.*

**Working assumption**: Dispatcher checks for `app.store.uninstalled`; if real event is `app.uninstalled`, both must be handled. Implementation should check both strings until confirmed.

**Payload shape**: `{ event, merchant, data: {} }` — `data` is empty for uninstall events.

**Handler**: Delete `SALLA_TOKENS` key `store:{storeId}`. KV delete is a no-op on missing key — inherently idempotent.

### T006d: Salla OAuth Scope Strings

*🟡 ALL SCOPE STRINGS UNVERIFIED. Derived from Salla API docs format inference.*

Salla uses **dot-notation** for scopes in their OAuth flow (e.g., `orders.read_write`, `products.read_write`). However, the exact strings depend on the Partner Portal scope picker and the installed app's granted scopes.

**Working assumptions for `src/constants.ts`**:

| Capability | Assumed scope string | Alternate seen |
|---|---|---|
| Read orders | `orders.read_write` | `offline_access` may be required |
| Update orders | `orders.read_write` | Same scope covers read and write |
| Read products/catalog | `products.read_write` | `products.read` if separate |
| Read inventory | `products.read_write` | May be separate `inventory` scope |
| Read shipments | `shipments.read` | May be part of `orders.read_write` |

**Action required**: Log into Salla Partner Portal → App settings → Scopes section. Document exact scope strings. Update `src/constants.ts` `TOOL_SCOPE_MAP` accordingly.

### T006e: Salla API Endpoint Paths

**Base URL**: `https://api.salla.dev/admin/v2/` — confirmed from Salla API documentation.

**Auth header**: `Authorization: Bearer {access_token}` — standard OAuth 2.0 Bearer.

**Endpoint paths** (🟡 UNVERIFIED — based on Salla API reference structure):

| Tool | Method | Path |
|---|---|---|
| `list_orders` | GET | `/orders` |
| `get_order` | GET | `/orders/{id}` |
| `update_order_status` | PUT | `/orders/{id}/status` |
| `search_catalog` | GET | `/products` |
| `get_inventory_levels` | GET | `/products/{id}/quantities` |
| `get_shipment_tracking` | GET | `/shipments/{id}` |

**Response envelope**: Salla API wraps responses in `{ status: number, success: boolean, data: {...} | [...] }`.

**Error responses**: Salla returns `{ status: number, error: { code: string, message: string } }` for errors.

*Confirm endpoint paths against https://docs.salla.dev/426392m0 before implementing salla-client.ts.*

### T006f: Salla Refresh Token Rotation Behavior

**Decision**: Assume **always rotates both access token and refresh token** on each refresh call.

**Rationale**: Salla docs state that calling `https://accounts.salla.sa/oauth2/token` with `grant_type=refresh_token` returns a new `access_token` and a new `refresh_token`. The old refresh token is invalidated. This is standard OAuth 2.0 refresh token rotation.

**Implementation consequence**: The `lib/refresh.ts` handler (T040) must:
1. Write the new `refresh_token` to KV atomically with the new `access_token`.
2. Preserve the old `refresh_token` in `previous_refresh_token` for the grace window (in case the new token write fails before the next Salla call succeeds).
3. Clear `previous_refresh_token` on the next successful refresh.

**`expires` field in refresh response**: Unlike the webhook, the refresh response uses `expires_in` as a **duration in seconds** (not absolute timestamp). `accessExpiresAtMs = Date.now() + tokenResp.expires_in * 1000`.

*🟡 UNVERIFIED — confirm whether Salla always rotates the refresh token or only rotates it sometimes. If rotation is optional, the grace-window logic in data-model.md may need adjustment.*

## T006 Live Webhook Capture (verified)

**Captured**: <date>
**Source**: Demo store <store-id> via webhook.site

### Signature header

- Header name: <exact name, e.g., X-Salla-Signature>
- Encoding: <raw hex / sha256={hex} / base64 / etc.>
- Algorithm: <HMAC-SHA256 confirmed via test signing>
- Signed content: <raw body bytes — confirmed by reproducing the signature locally>

### Common payload shape

<paste the actual top-level structure — likely {event, merchant, data} but may differ>

### Field paths (confirmed)

- store_id: <e.g., merchant or data.merchant.id or data.store.id>
- access_token: <field path>
- refresh_token: <field path>
- expires: <field path>
- expires field semantics: <Unix timestamp confirmed>
- scope: <field path>
- scope format: <space-separated string OR JSON array>

### app.store.authorize

<paste full JSON body, redact actual token values to "REDACTED">

### app.updated

<paste full JSON body, redact tokens>

**Carries tokens?** <YES/NO>
**Followed by app.store.authorize?** <YES/NO>
**Decision for handler model**: <notification-only / token-bearing>

### app.store.uninstalled

<paste full JSON body>

**Exact event name string**: <e.g., "app.store.uninstalled">

### Scope identifiers (confirmed)

<list the exact scope strings as they appear in the captured payloads, e.g.>
- orders.read
- orders.read_write
- products.read
- products.read_write
- shipments.read