# Implementation Plan: Salla Merchant MCP Server

**Branch**: `001-salla-merchant-mcp` | **Date**: 2026-04-29 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/001-salla-merchant-mcp/spec.md`

## Summary

A stateless Cloudflare Worker that bridges Salla merchant stores to any MCP-capable AI assistant. Salla pushes OAuth tokens via Easy Mode webhooks (the only mode allowed for published Salla App Store apps); the Worker stores them AES-GCM-encrypted in Workers KV using per-store keys derived from a versioned base secret. The Salla Dashboard mints signed HS256 install-URL JWTs that MCP clients present as Bearer tokens. Each tool call verifies the JWT (2 KV reads: hashed-jti denylist + merchant record), enforces a scope ceiling (JWT minted scopes ∩ live Salla scopes), rate-limits at 60 req/min via the Workers Rate Limiting binding (zero KV writes), then calls the Salla API on the merchant's behalf using the auto-refreshed Salla access token. No sessions, no SSE, no Durable Objects.

## Technical Context

**Language/Version**: TypeScript (strict mode)
**Primary Dependencies**: Hono (routing + middleware), `@modelcontextprotocol/sdk` (MCP Streamable HTTP stateless), Zod (schema validation), WebCrypto API (AES-GCM, HMAC-SHA256, HKDF — built into Workers runtime)
**Storage**: Workers KV — two namespaces:
- `SALLA_TOKENS` — merchant credentials keyed by `store:{store_id}`; refresh-mutex sentinel keyed by `refresh_lock:{store_id}`
- `JWT_DENYLIST` — revoked install URL JTI flags keyed by `jti:{sha256(jti)}`, auto-expiring at JWT expiry

**Testing**: Vitest + `@cloudflare/vitest-pool-workers` (Workers runtime; gives real KV, crypto, and binding APIs in unit tests)
**Target Platform**: Cloudflare Workers (global edge, V8 isolates, WebCrypto built-in, Rate Limiting binding)
**Performance Goals**: Worker-added latency <50 ms p99; rate-limit gate <1 ms (Workers binding, not KV)
**Constraints**: ≤2 KV reads per tool call steady state; zero KV writes per tool call except at ~14-day refresh boundary
**Scale/Scope**: Thousands of merchants; one active install URL per merchant in v1; no per-connection state

## Salla OAuth Contract (verified against `https://docs.salla.dev/421118m0`)

| Element | Value |
|---|---|
| OAuth mode | Easy Mode (mandatory for published apps) |
| Token endpoint | `https://accounts.salla.sa/oauth2/token` |
| User info endpoint | `https://accounts.salla.sa/oauth2/user/info` |
| API base URL | `https://api.salla.dev/admin/v2/` |
| Authorization header | `Bearer <ACCESS_TOKEN>` |
| Access token TTL | 14 days |
| Refresh token TTL | 30 days |
| Refresh token reuse | **Single-use only**; parallel use revokes all access and requires reinstall |
| `expires` field | Unix timestamp in `app.store.authorize` payload; seconds duration in token endpoint response |

**Implementation prerequisites** (NOT confirmed in the published docs; verify before coding `webhooks/salla.ts` and `lib/salla-client.ts`):
- Webhook signature header name and signing algorithm
- Webhook signing secret rotation policy
- Exact scope identifier strings (`orders.read`, `orders:read`, `read_orders`, etc.)
- Whether the token refresh response always rotates the refresh token or sometimes only the access token

## Constitution Check

*Checked before Phase 0. Re-evaluated after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| 1. Two-token isolation | ✅ PASS | Install JWT never forwarded to Salla; Salla tokens never returned to MCP client |
| 2. Single credential boundary | ✅ PASS | `lib/token-store.ts::getValidSallaToken()` is the only path to Salla credentials |
| 3. Stateless tools | ✅ PASS | No sessions, no Durable Objects; `McpServer` created fresh per request |
| 4. Encryption at rest | ✅ PASS | AES-GCM (WebCrypto); per-store key derived via HKDF-SHA256 from versioned base secret |
| 5. No secrets in logs | ✅ PASS | Logger allowlist: `store_id`, `jti`, `tool_name`, `status_code`, `latency_ms` only |
| 6. Scope enforcement at two layers | ✅ PASS | JWT scope ceiling at `tools/list`; live Salla scopes re-validated at `tools/call` |
| 7. Refresh is a critical section | ✅ PASS | KV-based mutex; Salla itself does NOT have a grace window (single-use refresh) — our mutex is the only protection against lockout |
| 8. Webhook signature verification | ✅ PASS | HMAC verify before any handler logic; all handlers idempotent |
| 9. Spec deviations documented | ✅ PASS | `docs/spec-deviations.md` created in Phase 1 |
| 10. Auth code requires tests | ✅ PASS | Unit tests required for auth, token-store, JWT, crypto, webhook-verify, scope, refresh mutex |

No gate violations. Complexity tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-salla-merchant-mcp/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── quickstart.md        ← Phase 1 output
├── contracts/
│   ├── mcp-endpoint.md
│   ├── webhooks.md
│   └── internal-api.md
└── tasks.md             ← /speckit.tasks output (not created here)
```

### Source Code (repository root)

```text
src/
├── index.ts                           # Hono app; route registration; Workers fetch export
├── types.ts                           # Env bindings interface, shared types
├── constants.ts                       # Scope names, tool-to-scope map, config defaults
│
├── middleware/
│   ├── auth.ts                        # JWT verify; injects { storeId, jti, effectiveScopes } into context
│   ├── auth-internal.ts               # HMAC-based service-to-service auth for /internal/* routes
│   └── logger.ts                      # Structured emitter; scrubs secrets by default
│
├── webhooks/
│   └── salla.ts                       # authorize / updated / uninstalled handlers (HMAC-verified, idempotent)
│
├── internal/
│   ├── mint.ts                        # POST /internal/mint
│   └── revoke.ts                      # POST /internal/revoke
│
├── mcp/
│   ├── handler.ts                     # Streamable HTTP entry; per-request McpServer
│   ├── initialize.ts                  # initialize response builder
│   ├── tools-list.ts                  # tools/list filtered by effectiveScopes
│   └── tools/
│       ├── registry.ts                # Tool definitions + scope requirements + future requiresElicitation flag
│       ├── list-orders.ts
│       ├── get-order.ts
│       ├── update-order-status.ts
│       ├── search-catalog.ts
│       ├── get-inventory-levels.ts
│       ├── get-shipment-tracking.ts
│       └── whoami.ts
│
└── lib/
    ├── token-store.ts                 # getValidSallaToken(storeId, env) — single credential boundary
    ├── refresh.ts                     # Salla token refresh with KV mutex; Salla rejects parallel refresh
    ├── crypto.ts                      # AES-GCM encrypt/decrypt with HKDF key derivation
    ├── jwt.ts                         # Install URL JWT sign/verify (HS256, WebCrypto)
    ├── salla-client.ts                # Typed Salla API HTTP client
    └── scope.ts                       # Scope intersection logic

docs/
└── spec-deviations.md

tests/
├── unit/
│   ├── auth.test.ts
│   ├── auth-internal.test.ts
│   ├── token-store.test.ts
│   ├── refresh.test.ts                # parallel refresh mutex, lock contention, lockout-prevention
│   ├── jwt.test.ts
│   ├── crypto.test.ts                 # encrypt/decrypt roundtrip, key derivation, version handling
│   ├── webhook-verification.test.ts
│   └── scope.test.ts
└── integration/
    ├── webhooks.test.ts
    ├── mcp-tools.test.ts
    └── mint-revoke.test.ts

wrangler.toml
package.json
tsconfig.json
.dev.vars                              # Local secrets (gitignored)
```

**Structure Decision**: Single-project Cloudflare Workers layout. `src/` is the sole source root. Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers` so platform APIs (KV, WebCrypto, Rate Limiting) are real in unit tests.

## Key Design Decisions

### 1. Two-Read KV Hot Path

Every tool call reads exactly two KV records:

| Read | Namespace | Key | Purpose |
|------|-----------|-----|---------|
| 1 | `JWT_DENYLIST` | `jti:{sha256(jti)}` | Revocation check — present = 401 |
| 2 | `SALLA_TOKENS` | `store:{storeId}` | Encrypted credentials + live scopes |

`storeId` is extracted from the verified JWT `sub` claim (in-memory, no KV). The `active_jti` field inside the encrypted merchant record is only accessed during mint/revoke operations — not on the tool-call hot path.

The denylist is keyed by `sha256(jti)`, not the plaintext jti. This means a KV dump of the denylist never reveals live JTIs in plaintext, only their hashes. The lookup is performed by hashing the verified JWT's `jti` claim and querying the corresponding key.

### 2. Scope Ceiling (Intersection Model)

The install URL JWT carries a `scope` claim (array of strings) representing the **scope ceiling at mint time**. Effective scope for any request = `jwtScopes ∩ liveSallaScopes`. Computed in-memory after the two KV reads. The merchant's live scopes can only ever shrink the effective set, never expand it. `whoami` is exempt from scope gating and always available.

### 3. Encryption Key Derivation

The encryption base key is held in Worker Secrets, **not in KV**. Per-record keys are derived using HKDF-SHA256 to give each store its own effective encryption key:

```
record_key = HKDF-SHA256(
  ikm  = TOKEN_ENC_KEY_V{n}    // Worker secret, base64 32 bytes
  salt = ENCRYPTION_SALT       // Worker secret, fixed per environment
  info = "salla-mcp:store:" + store_id
  L    = 32 bytes
)
```

Each merchant record stores `key_version` (integer). On read, the Worker selects the matching `TOKEN_ENC_KEY_V{n}` secret. On every successful write (refresh, app.updated), the record is re-encrypted with the **current** active version. This enables lazy key rotation: bump the active version, deploy, and records re-encrypt themselves at their next refresh. Old key versions remain available in Worker Secrets until all records are confirmed migrated.

A KV dump alone reveals only ciphertext; an attacker would also need access to Worker Secrets to decrypt anything.

### 4. Refresh Mutex (Critical — Salla has no grace window)

Workers KV has no native CAS. The mutex is implemented as a short-TTL KV key:

```
SALLA_TOKENS  key: refresh_lock:{storeId}  →  "1"  TTL: 30 s
```

**Why this matters more than usual.** The Salla docs are explicit: refresh tokens are single-use. Any parallel refresh attempt **invalidates the refresh token, revokes all access tokens obtained with it, and forces the merchant to reinstall the app**. There is no grace window on Salla's side — the old refresh token is dead the instant the new one is issued. The mutex below is the only protection against this scenario.

**Mutex algorithm:**
1. Caller A reads merchant record. Notices `access_expires_at - now < refreshWindow` (default 60 minutes).
2. Caller A reads `refresh_lock:{storeId}`. If present, goto step 6 (wait path).
3. Caller A writes `refresh_lock:{storeId} = "1"` with `expirationTtl: 30`.
4. Caller A re-reads the merchant record. If `access_expires_at` has advanced past the refresh window, another worker beat us — release the lock and use the now-fresh token.
5. Caller A POSTs to `https://accounts.salla.sa/oauth2/token` with the refresh token. On success, write the new merchant record (encrypted, current key version, both new tokens). On failure, set `status: "refresh_failed"` and return 401 to the MCP client per FR-021. In both cases, **delete** `refresh_lock:{storeId}` explicitly.
6. **Wait path:** Caller B finds the lock present. Caller B re-reads the merchant record up to 5 times with 200ms backoff between reads. After each read, B checks whether `access_expires_at` has advanced (indicating A succeeded). If yes, use the new token. If after 5 retries (~1s) the record has not advanced, return HTTP 502 to the MCP client with retry guidance.

**About the `previous_refresh_token` field:** the data model retains the previous refresh token for one cycle, but **only as protection against our own KV write failures**, not as a Salla grace-window mechanism. If we successfully refresh against Salla but our KV write fails, we still have the new tokens in memory; on retry, we know which generation we are on. This is a defense against split-brain after our own infrastructure failures, not against Salla's invalidation rules.

### 5. Atomic Mint (One Active URL per Merchant in v1)

```
1. Read store:{storeId}  →  decrypt  →  extract active_jti
2. If active_jti non-null  →  write jti:{sha256(active_jti)} to JWT_DENYLIST (TTL = old JWT exp)
3. Generate new jti = crypto.randomUUID()
4. Sign new JWT with new jti
5. Write store:{storeId} with new active_jti (encrypted)
6. Return signed install URL
```

Steps 2–5 are not transactionally atomic (Workers KV limitation). The race window is microseconds; consequences are benign because the old JTI is in the denylist before the new URL is returned to the Dashboard.

**Future-proofing for v2:** the data model treats install URLs as a separate concept keyed by globally unique `jti` (matching FR-030, no reuse across uninstall/reinstall), NOT as a single field on the merchant record. The "one active URL per merchant" rule is enforced as **mint-time policy** (revoke previous before issuing new), not as a schema constraint. Adding multi-URL support in v2 will be a policy change, not a migration.

### 6. MCP Streamable HTTP — Per-Request McpServer

```typescript
// In mcp/handler.ts — fresh per request
const server = new McpServer({ name: 'salla-mcp', version: '1.0.0' });
// Register tools filtered by effectiveScopes
// Handle the single incoming request
// Return single JSON response
```

No global server state. Constitution principle 3 (stateless) enforced by construction.

### 7. Webhook Idempotency

- `app.store.authorize` / `app.updated`: KV `put` is a full overwrite — identical result on replay.
- `app.store.uninstalled`: KV `delete` on non-existent key is a no-op in Workers KV.
- The webhook handler tolerates re-delivery without state divergence.

**Note on `expires` field handling:** for `app.store.authorize` events the `expires` field is a Unix timestamp; for token refresh responses from `https://accounts.salla.sa/oauth2/token` it is a duration in seconds. The two code paths (`webhooks/salla.ts` and `lib/refresh.ts`) interpret it differently and must not share parsing logic.

### 8. Rate Limiting

```typescript
// In middleware/auth.ts, after JWT verification
const { success } = await env.RATE_LIMITER.limit({ key: jti });
if (!success) {
  return c.json(
    { error: 'rate_limit_exceeded' },
    429,
    { 'Retry-After': '60' }
  );
}
```

Gate runs after auth (so we have the `jti`), before tool dispatch. The Workers Rate Limiting binding maintains counters in Cloudflare's network — zero KV reads or writes — preserving SC-006. Default 60 requests/minute per install URL revocation identifier; configurable.

### 9. Internal Endpoint Authentication

`/internal/mint` and `/internal/revoke` are gated by `middleware/auth-internal.ts`:

- Required header: `X-Salla-Internal-Auth` carrying `hmac-sha256(INTERNAL_API_SECRET, body || timestamp)` as hex.
- Required header: `X-Salla-Internal-Timestamp` (Unix seconds) within ±300 seconds of `Date.now()/1000`.
- Constant-time HMAC comparison.
- Reject with HTTP 401 on any of: missing headers, stale timestamp, signature mismatch.

The Salla Dashboard backend implements the signing side; the Worker only validates incoming headers. No replay protection beyond the timestamp window in v1; nonce-based replay protection is a v2 enhancement.

### 10. `update_order_status` Confirmation Hint

The `update_order_status` tool description carries a string-level instruction encouraging the AI client to obtain user confirmation before invocation. **This is a description, not a server-side gate.** The system does not enforce confirmation in v1.

The tool registry type leaves room for future enforcement:

```typescript
type Tool = {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  requiredScopes: string[];
  requiresElicitation?: boolean;  // future: trigger MCP elicitation flow
  handler: (args, ctx) => Promise<ToolResult>;
};
```

When MCP elicitation support stabilizes across major MCP clients (Claude Desktop, Cursor, ChatGPT), `requiresElicitation: true` will gate execution behind an elicitation round-trip without changing tool handler code.

## Phase 0: Research

See [research.md](research.md).

Stack fully resolved by the project constitution. Salla API specifics partially confirmed against the published docs; remaining items are listed in the **Implementation prerequisites** block above and must be confirmed against the Salla developer portal and a live demo store before implementation of `lib/salla-client.ts` and `webhooks/salla.ts`.

## Phase 1: Design Artifacts

- [data-model.md](data-model.md)
- [contracts/mcp-endpoint.md](contracts/mcp-endpoint.md)
- [contracts/webhooks.md](contracts/webhooks.md)
- [contracts/internal-api.md](contracts/internal-api.md)
- [quickstart.md](quickstart.md)
