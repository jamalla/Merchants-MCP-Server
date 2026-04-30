# Tasks: Salla Merchant MCP Server

**Input**: Design documents from `specs/001-salla-merchant-mcp/`
**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ contracts/ ✅

**Tests**: Unit tests are **required** (not optional) per the project constitution: *"Any PR touching authentication, token storage, refresh, webhook verification, or scope enforcement MUST include unit tests."* Test tasks are included below for all auth-critical paths.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. Within each phase, tasks marked `[P]` may run in parallel.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on in-progress tasks)
- **[Story]**: Which user story this task belongs to (US1–US7, or [FOUND] for foundational work)
- Exact file paths are included in every task description

---

## Phase 1: Setup (Project Initialization)

**Purpose**: Scaffold the Cloudflare Workers project. No dependencies — start immediately.

- [x] **T001** Initialize npm project: create `package.json` with dependencies (`hono`, `@modelcontextprotocol/sdk`, `zod`, `wrangler`) and devDependencies (`vitest`, `@cloudflare/vitest-pool-workers`, `typescript`)
- [x] **T002** [P] Configure TypeScript strict mode: create `tsconfig.json` with `"strict": true`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"lib": ["ESNext"]`, `"types": ["@cloudflare/workers-types"]`
- [x] **T003** [P] Configure Wrangler: create `wrangler.toml` with KV namespace bindings (`SALLA_TOKENS`, `JWT_DENYLIST`), Rate Limiting binding (`RATE_LIMITER`, 60 req/60 s), route `GET|POST /v1/mcp`, and environment variable defaults for dev/staging/production
- [x] **T004** [P] Configure Vitest: create `vitest.config.ts` with `@cloudflare/vitest-pool-workers` pool so Workers APIs (KV, WebCrypto, Rate Limiting) are real in unit tests
- [x] **T005** [P] Create `.dev.vars` template and `.gitignore` entry; document required secrets in a comment block: `TOKEN_ENC_KEY_V1`, `ENCRYPTION_SALT`, `ACTIVE_KEY_VERSION`, `JWT_SIGNING_SECRET`, `SALLA_WEBHOOK_SECRET_V1`, `INTERNAL_API_SECRET_V1`, `SALLA_CLIENT_ID`, `SALLA_CLIENT_SECRET`

**Checkpoint**: `npx wrangler dev` starts with no errors; `npm test` runs (zero tests pass — that's expected here).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core libraries and infrastructure that every user story depends on. No user story work can begin until this phase is complete.

**⚠️ CRITICAL**: Complete and validate all foundational tasks before starting Phase 3.

### Salla integration verification (BLOCKS T015, T016, T018, T019, T036, T041)

These verification tasks resolve the `🟡 unverified` items from `contracts/webhooks.md` and assumed values in `data-model.md`. Each MUST produce a written artifact in `specs/001-salla-merchant-mcp/research.md` (append, do not replace) so findings are auditable.

- [x] **T006a** [FOUND] Capture a real `app.store.authorize` webhook from a Salla demo store install. Document in `research.md`: exact signature header name (e.g. `X-Salla-Signature`), signature encoding format (raw hex / `sha256={hex}` / base64), full payload structure (top-level event/merchant/data shape), exact field paths for `store_id`, `access_token`, `refresh_token`, `expires`, `scope`, and the format of `scope` (space-separated string vs JSON array). Capture the exact `expires` value and confirm it is an absolute Unix timestamp per the Salla docs.
- [x] **T006b** [FOUND] Capture an `app.updated` webhook by changing scopes on the demo store. Document in `research.md`: whether the payload carries new tokens (which would contradict the docs' notification-only model), the exact event name, and the field paths. Decide and record which `app.updated` handler model (notification-only vs token-bearing) the implementation will use.
- [x] **T006c** [FOUND] Capture an `app.store.uninstalled` (or equivalent) webhook by uninstalling the app from the demo store. Document in `research.md`: the exact event name string (the dispatcher branches on this), the payload shape, and confirm against the Salla Store Events list at `https://docs.salla.dev/433811m0`.
- [x] **T006d** [FOUND] Confirm Salla scope identifier strings against the Partners Portal scope picker. List in `research.md` the exact scope strings for: orders read, orders write, products read (and whether inventory is a separate scope), shipments read. Cross-reference the `Store Scopes` API endpoints (`https://docs.salla.dev/15104922e0`, `https://docs.salla.dev/15107150e0`) for canonical names.
- [x] **T006e** [FOUND] Confirm Salla API base URL (`https://api.salla.dev/admin/v2/` per docs) and the 6 tool endpoint paths against the published API documentation at `https://docs.salla.dev/426392m0`. Document each endpoint path, method, and notable response shape in `research.md`.
- [x] **T006f** [FOUND] Confirm whether `https://accounts.salla.sa/oauth2/token` always rotates the refresh token on refresh, or sometimes only the access token. Document in `research.md` and adjust the refresh handler accordingly.

### Shared library implementation

- [x] **T007** [FOUND] Define `Env` interface (KV namespaces, Rate Limiting binding, all secret names per `data-model.md`) and shared TypeScript types (`MerchantRecord`, `InstallURLTokenPayload`, `StoreContext`, `RevokedJTI`) in `src/types.ts`. Reference `data-model.md §Entity: MerchantRecord` for exact field shapes.
- [x] **T008** [P] [FOUND] Implement crypto primitives in `src/lib/crypto.ts`:
  - `deriveKey(env, storeId, version)` — HKDF-SHA256 from `TOKEN_ENC_KEY_V{version}` with `ENCRYPTION_SALT` as salt and `"salla-mcp:store:" + storeId` as info; output 32-byte AES-GCM key.
  - `encryptField(plaintext, env, storeId, version)` → `{ ct, iv }` with random 12-byte IV.
  - `decryptField(ct, iv, env, storeId, version)` → plaintext.
  - `currentKeyVersion(env)` reads `ACTIVE_KEY_VERSION` from env.
  Per `data-model.md §Crypto`. Plaintext tokens MUST never exit the in-memory scope of a single function call.
- [x] **T009** [P] [FOUND] Implement `signJWT(payload, env)` and `verifyJWT(token, env)` using HS256 via `crypto.subtle.sign/verify`; payload claims per `data-model.md §InstallURLTokenPayload` (iss, aud, sub, store_id, jti, iat, exp, scope, optional kid for signing-key rotation) in `src/lib/jwt.ts`
- [x] **T010** [P] [FOUND] Implement HMAC primitives in `src/lib/hmac.ts`: `hmacSha256Hex(key, body)` for webhook signature verification and internal-API authentication; `timingSafeEqualHex(a, b)` for constant-time comparison
- [x] **T011** [P] [FOUND] Implement `scopeIntersection(jwtScopes, liveScopes)` and `hasRequiredScopes(effectiveScopes, requiredScopes)` in `src/lib/scope.ts`
- [x] **T012** [P] [FOUND] Implement structured logger in `src/middleware/logger.ts`: `createLogger(c)` emitting JSON with allowlisted fields only (`store_id`, `jti`, `tool_name`, `method`, `endpoint`, `webhook_event`, `outcome`, `status_code`, `latency_ms`, `event`, `level`, `ts`, `request_id`); reject any attempt to log token values, secrets, request bodies, or scope arrays
- [x] **T013** [P] [FOUND] Implement request_id middleware in `src/middleware/request-id.ts`: generate `crypto.randomUUID()` per request, attach to context, include in every log entry. Mount before logger.
- [x] **T014** [FOUND] Implement HMAC-based internal-API auth middleware in `src/middleware/auth-internal.ts` per `contracts/internal-api.md §Authentication`:
  - Require headers `X-Salla-Internal-Auth` and `X-Salla-Internal-Timestamp`.
  - Reject if timestamp outside ±300 seconds of `Date.now()/1000`.
  - Recompute HMAC-SHA256 over `{timestamp}.{rawBody}` using each `INTERNAL_API_SECRET_V{n}` Worker secret in priority order.
  - Constant-time comparison via `timingSafeEqualHex`.
  - On failure: log WARN (no header values, no body), return HTTP 401 `{"error": "unauthorized"}`.

### Foundational unit tests (required by constitution principle 10)

- [x] **T015** [FOUND] Write unit tests in `tests/unit/crypto.test.ts`:
  - encrypt/decrypt round-trip succeeds for store A, fails for store B (per-store key derivation)
  - tamper detection (modified ciphertext throws)
  - wrong key version fails to decrypt
  - different IVs produce different ciphertexts for the same plaintext
  - lazy key rotation: record encrypted with V1 can be decrypted using V1 even when ACTIVE_KEY_VERSION=V2
- [x] **T016** [P] [FOUND] Write unit tests in `tests/unit/jwt.test.ts`: sign/verify round-trip; expired token rejects; tampered payload rejects; wrong `aud` rejects; missing `jti` rejects; signing-key rotation via `kid` claim
- [x] **T017** [P] [FOUND] Write unit tests in `tests/unit/scope.test.ts`: intersection of overlapping scopes; empty intersection returns empty; whoami exemption (empty required scopes always passes); ceiling enforcement (JWT scope absent from live scopes is excluded)
- [x] **T018** [P] [FOUND] Write unit tests in `tests/unit/hmac.test.ts`: known-vector HMAC-SHA256; constant-time comparison does not short-circuit; same input produces same output across runs
- [x] **T019** [P] [FOUND] Write unit tests in `tests/unit/auth-internal.test.ts`:
  - valid headers + valid HMAC + in-window timestamp → 200
  - missing headers → 401
  - timestamp older than 5 minutes → 401
  - timestamp from the future beyond skew → 401
  - HMAC mismatch → 401
  - secret rotation: signing with V1 still validates while V2 is active
- [x] **T020** [P] [FOUND] Write unit tests in `tests/unit/logger.test.ts`: allowlisted fields pass through; non-allowlisted fields are rejected/dropped (whichever the implementation chose); no token-shaped values escape

### Salla API client (depends on T006a-T006f verification)

- [x] **T021** [FOUND] Implement typed Salla API HTTP client in `src/lib/salla-client.ts` with methods for the 6 tool endpoints; injects `Authorization: Bearer <accessToken>` per Salla docs; error mapping per `contracts/mcp-endpoint.md §Error Code Summary` (Salla 5xx → HTTP 502 `upstream_error`, Salla 429 → HTTP 429 `upstream_rate_limited` with `Retry-After` forwarded, Salla 401 → triggers refresh path). *Depends on T006e for endpoint paths.*
- [x] **T022** [FOUND] Define `TOOL_SCOPE_MAP` and Salla OAuth scope string constants in `src/constants.ts`. *Depends on T006d for confirmed scope strings.*
- [x] **T023** [FOUND] Create Hono app skeleton with global error handler, 404 handler, request_id middleware, logger middleware, and route stubs (webhooks, internal, MCP) in `src/index.ts`; export `default { fetch: app.fetch }` as Workers entry point

**Checkpoint**: All Phase 2 unit tests pass. `wrangler dev` starts cleanly. `research.md` contains documented findings from T006a–T006f. No user story work begins until this checkpoint is green.

---

## Phase 3: User Story 1 — Merchant App Install & Token Storage (Priority: P1) 🎯 MVP

**Goal**: Receive Salla Easy Mode webhooks, verify signatures, and store encrypted merchant credentials in KV with replay/reorder protection.

**Independent Test**: POST a simulated `app.store.authorize` webhook with a valid HMAC signature → KV contains an encrypted MerchantRecord under `store:{storeId}`. Replay the identical webhook → same KV state. POST an older event with a smaller `expires` value → ignored as replay, KV unchanged. POST with invalid signature → HTTP 403, KV unchanged.

- [x] **T024** [US1] Implement webhook signature verification in `src/webhooks/salla.ts`:
  - Use the header name and encoding from T006a's documented findings.
  - Try each `SALLA_WEBHOOK_SECRET_V{n}` in priority order (rotation support).
  - Sign over raw request body bytes; constant-time comparison.
  - On failure: HTTP 403, no state change, log entry contains only `{outcome: "signature_invalid", request_id}`.
- [x] **T025** [US1] Implement `app.store.authorize` handler in `src/webhooks/salla.ts`:
  - Parse `storeId` from the verified field path (per T006a findings).
  - Parse `data.access_token`, `data.refresh_token`, `data.scope` (split appropriately per T006a finding).
  - Convert `data.expires`: it is an **absolute Unix timestamp** per the Salla docs and `contracts/webhooks.md §Critical: expires field semantics`. Compute `accessExpiresAtMs = data.expires * 1000`. Do NOT add to `now`.
  - **Replay/reorder protection (FR-006):** read existing record at `store:{storeId}`. If a record exists and `accessExpiresAtMs <= existingRecord.access_expires_at`, log `{outcome: "replay_ignored"}` and return HTTP 200 with no state change.
  - Set `installed_at = now` only on first write; preserve on subsequent.
  - Set `refresh_expires_at = now + 30 * 24 * 3600 * 1000` (30 days per Salla docs).
  - Encrypt `access_token` and `refresh_token` with current key version using per-store HKDF-derived key (T008).
  - Set `status = 'active'`, `key_version = currentKeyVersion(env)`, `schema_version = 1`.
  - Write to `SALLA_TOKENS` key `store:{storeId}`.
  - Return HTTP 200 with `{outcome: "stored"}`.
- [x] **T026** [US1] Wire `POST /webhooks/salla` route in `src/index.ts`. Handler dispatches on `event` field; unknown events log WARN with `outcome: "unknown_event"` and return HTTP 200 (do not 4xx Salla — they will retry).
- [x] **T027** [US1] Write unit tests in `tests/unit/webhook-verification.test.ts`: valid signature passes; invalid signature returns 403; missing signature header returns 403; multiple secret versions tried in order; timing-safe comparison used
- [x] **T028** [US1] Write integration tests in `tests/integration/webhooks.test.ts` for `app.store.authorize`:
  - Simulate signed webhook → assert `SALLA_TOKENS` contains decryptable record with correct fields
  - Replay same webhook → state unchanged, returns 200 with replay_ignored OR stored (idempotent either way)
  - Older `expires` than stored → replay_ignored, KV unchanged
  - Invalid signature → 403, KV unchanged
  - Unknown event name → 200 with no state change, WARN logged

**Checkpoint**: Run integration tests for US1. Run `quickstart.md §webhook simulation`. MerchantRecord is stored, encrypted, and idempotent under replay.

---

## Phase 4: User Story 2 — Install URL Generation & AI Client Connection (Priority: P1)

**Goal**: Mint a signed install URL via the internal API; MCP clients can initialize, list tools, and call tools using that URL. Establishes the full hot path.

**Independent Test**: POST to `/internal/mint` with valid HMAC headers → 200 with install_url. Use the URL's token in `Authorization: Bearer` → `initialize` returns server info; `tools/list` returns tools matching minted scopes (intersected with merchant's live scopes); `tools/call whoami` returns store context. Requires a MerchantRecord from US1.

- [x] **T029** [US2] Implement `getValidSallaToken(storeId, env)` in `src/lib/token-store.ts` (the single credential boundary per constitution principle 2):
  - Read `SALLA_TOKENS` key `store:{storeId}`. If absent return null.
  - If `status === 'refresh_failed'` throw `RefreshFailedError`.
  - Decrypt access and refresh tokens using `key_version` field.
  - Refresh logic added in US5 (T040). For now, throw if `access_expires_at < now` (will be replaced by refresh trigger in US5).
  - Return `{ accessToken, scopes }`.
- [x] **T030** [US2] Implement JWT auth middleware in `src/middleware/auth.ts` per `contracts/mcp-endpoint.md §Token Validation Steps`:
  - Extract token from `Authorization: Bearer` header (preferred) or `?token=` query parameter.
  - **Dual-source handling (FR-027):** if both present, use header value. If both non-empty and differ, log WARN with `{outcome: "token_source_conflict"}` recording only the JTI from the header value (no token contents).
  - Verify HS256 signature; check `exp`; check `iss`/`aud`; reject → HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`.
  - Compute `sha256(jti)` (hex) and check `JWT_DENYLIST.get('jti:' + sha256Hex)`. If present → HTTP 401.
  - Read `SALLA_TOKENS.get('store:' + sub)`. If absent or `status='refresh_failed'` → HTTP 401 (refresh_failed: include `error_description` per `contracts/mcp-endpoint.md`).
  - Compute `effectiveScopes = jwtPayload.scope ∩ merchantRecord.scopes` via `scopeIntersection`.
  - Apply `RATE_LIMITER.limit({ key: jti })`. If exceeded → HTTP 429 with `Retry-After: 60`.
  - Inject `StoreContext { storeId, jti, effectiveScopes, sallaAccessToken }` into Hono context.
- [x] **T031** [US2] Write unit tests in `tests/unit/auth.test.ts` for the auth middleware. Each must verify the exact HTTP status and `WWW-Authenticate` header per `contracts/mcp-endpoint.md §Error Code Summary`:
  - Valid token → 200, context populated
  - Expired JWT → 401 `invalid_token`
  - Tampered signature → 401 `invalid_token`
  - JTI on denylist → 401 `invalid_token`
  - Missing merchant record → 401 `invalid_token`
  - `status='refresh_failed'` → 401 `reinstall_required` with `error_description`
  - Token in header AND query, both same → uses header, no warn
  - Token in header AND query, different → uses header, WARN logged with JTI only
  - Rate limit exceeded → 429 `rate_limit_exceeded` with `Retry-After: 60`
- [x] **T032** [US2] Implement `/internal/mint` endpoint in `src/internal/mint.ts` per `contracts/internal-api.md §POST /internal/mint`:
  - Mounted behind `auth-internal.ts` (T014).
  - Read `MerchantRecord` from `SALLA_TOKENS` key `store:{storeId}`. Absent → HTTP 404 `store_not_found`.
  - **Scope-subset check (defense-in-depth):** if `requested_scopes ⊄ merchantRecord.scopes` → HTTP 400 `invalid_scopes`.
  - Validate `lifetime_seconds` (default 90 days, max 90 days). Out of range → HTTP 400 `invalid_lifetime`.
  - Generate `jti = crypto.randomUUID()`. Sign JWT with `JWT_SIGNING_SECRET` (HS256, includes `kid`).
  - Update merchant record: set `active_jti = newJti`, `updated_at = now`. Re-encrypt with current `key_version`. Write back to `SALLA_TOKENS`.
  - Return `{ install_url, jti, expires_at }`.
  - **Note:** atomic revocation of previous `active_jti` is added in US3 (T037). For now, mint without prior revocation.
- [x] **T033** [US2] Implement `initialize` response builder in `src/mcp/initialize.ts` (server name `"salla-mcp"`, version, capabilities `{tools: {}}`)
- [x] **T034** [P] [US2] Implement `tools/list` in `src/mcp/tools-list.ts`: filter `TOOL_SCOPE_MAP` by `effectiveScopes`; **always include `whoami` regardless of scopes (FR-015 exemption)**; return MCP-formatted tool list with full Zod-derived JSON schemas
- [x] **T035** [P] [US2] Implement tool registry in `src/mcp/tools/registry.ts`. The `Tool` type includes optional `requiresElicitation?: boolean` flag (defaulted to false; reserved for v2 — DO NOT enforce in v1).
- [x] **T036** [P] [US2] Implement tool handlers in `src/mcp/tools/`:
  - `list-orders.ts`, `get-order.ts`, `search-catalog.ts`, `get-inventory-levels.ts`, `get-shipment-tracking.ts`, `whoami.ts`: each with Zod input schema, scope declaration, and Salla client integration per `contracts/mcp-endpoint.md §Tool Schemas`.
  - `update-order-status.ts`: implements per `contracts/mcp-endpoint.md` BUT — per spec assumption and `plan.md §10` — the description string instructs the AI client to obtain user confirmation; the server does **NOT** enforce confirmation in v1. Do not add elicitation gating, prompt-for-confirmation logic, or any other server-side confirmation step. The `requiresElicitation` flag stays false.
- [x] **T037** [US2] Implement per-request MCP Streamable HTTP handler in `src/mcp/handler.ts`:
  - Instantiate fresh `McpServer` per request (constitution principle 3).
  - Dispatch `initialize` / `tools/list` / `tools/call`.
  - **Error mapping per `contracts/mcp-endpoint.md §Error Code Summary`:** map internal error types to HTTP status + JSON body + `WWW-Authenticate` header:
    | Internal error | HTTP | error code | extra |
    |---|---|---|---|
    | Zod validation fail | 400 | `invalid_input` | `detail` (sanitized) |
    | Insufficient scope | 403 | `insufficient_scope` | `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."` |
    | Salla 5xx | 502 | `upstream_error` | forward `Retry-After` if present |
    | Salla 429 | 429 | `upstream_rate_limited` | forward `Retry-After` |
    | Refresh in progress timeout | 502 | `refresh_in_progress` | `Retry-After: 2` |
- [x] **T038** [US2] Wire all routes in `src/index.ts`: `POST/GET /v1/mcp` (behind auth.ts + rate limit), `POST /internal/mint` (behind auth-internal.ts), `POST /internal/revoke` stub (full impl in US3), `POST /webhooks/salla` (already wired in T026)
- [x] **T039** [US2] Write integration tests in `tests/integration/mcp-tools.test.ts` for the full happy path:
  - authorize webhook → mint URL → `initialize` → `tools/list` → `tools/call whoami`
  - assert correct `store_id` and `effective_scopes` returned in whoami response
  - assert `tools/list` reflects scope ceiling (intersection of minted scopes and live scopes)
  - assert tool with input failing Zod validation returns 400 `invalid_input`
  - assert Salla 5xx response is mapped to HTTP 502 `upstream_error`

**Checkpoint**: Run `quickstart.md` steps 4–6 in full. Claude Desktop can connect, list tools, and call `whoami`. The MVP is shippable.

---

## Phase 5: User Story 3 — Install URL Revocation & Regeneration (Priority: P2)

**Goal**: Revoke an install URL immediately via the internal API; minting a new URL atomically revokes the previous one. Denylist uses hashed JTIs.

**Independent Test**: Mint URL A → revoke URL A → tool call with URL A returns 401. Mint URL B → tool call with URL B succeeds. URL A still returns 401. Revoking an already-superseded JTI returns 200 `already_revoked`.

- [X] **T040** [US3] Update `/internal/mint` (T032) to atomically revoke the previous active JTI:
  - Before signing the new JWT: if `merchantRecord.active_jti` is non-null, compute `oldJtiHash = sha256Hex(active_jti)`, compute TTL `(oldJwtExp - now/1000 + 60)` seconds (estimate from issuance metadata or use 90-day max).
  - Write `JWT_DENYLIST` key `jti:{oldJtiHash}` with the JSON revocation envelope `{revoked_at, reason: "regenerated", store_id}` and the computed TTL.
  - Then proceed with new JWT signing and merchant record update.
- [X] **T041** [US3] Implement `/internal/revoke` in `src/internal/revoke.ts` per `contracts/internal-api.md §POST /internal/revoke`:
  - Mounted behind `auth-internal.ts`.
  - Read merchant record. Absent → HTTP 404 `store_not_found`.
  - Write `JWT_DENYLIST` key `jti:{sha256Hex(jti)}` with revocation envelope and computed TTL (always perform this write — belt-and-braces).
  - If requested `jti === merchantRecord.active_jti`: set `active_jti = null`, `updated_at = now`, re-encrypt and write back. Return `200 {revoked: true, reason: "revoked"}`.
  - Otherwise: do NOT modify the merchant record. Return `200 {revoked: false, reason: "already_revoked"}`. This is the success-equivalent path for double-clicks and out-of-order revoke calls.
- [X] **T042** [US3] Wire `POST /internal/revoke` in `src/index.ts` (replacing the stub from T038)
- [X] **T043** [US3] Write unit tests in `tests/unit/internal-revoke.test.ts`:
  - revoke active JTI → 200 revoked, denylist contains hashed JTI, merchant record `active_jti` is null
  - revoke non-active JTI → 200 already_revoked, denylist still gets the hash written
  - revoke for unknown store → 404
  - HMAC auth failures (covered by T019, but verify integration here)
- [X] **T044** [US3] Write integration test in `tests/integration/mint-revoke.test.ts`:
  - mint URL A → mint URL B (which auto-revokes A) → tool call with A returns 401, tool call with B succeeds
  - mint URL A → explicit revoke A → tool call with A returns 401
  - explicit revoke A again → 200 already_revoked, no error
  - Salla tokens unchanged across the entire flow

**Checkpoint**: Revocation works immediately. Old URL is dead; new URL works. Salla tokens untouched. Denylist entries are hashed.

---

## Phase 6: User Story 4 — App Uninstall & Full Cleanup (Priority: P2)

**Goal**: Delete all merchant credentials when `app.store.uninstalled` fires; all install URLs stop working immediately without needing per-URL denylist entries.

**Independent Test**: Authorize → mint URL → `app.store.uninstalled` webhook → tool call returns 401 (no merchant record). Replay uninstall webhook → no error (idempotent).

- [X] **T045** [US4] Implement `app.store.uninstalled` handler in `src/webhooks/salla.ts`:
  - Use the exact event name string from T006c findings.
  - After signature verification: `env.SALLA_TOKENS.delete('store:' + storeId)`.
  - Return HTTP 200 with `{outcome: "uninstalled"}`.
  - **No JWT_DENYLIST writes are needed** — the absence of the merchant record causes any subsequent tool call to fail at the auth middleware's merchant-record read step (HTTP 401).
- [X] **T046** [US4] Write integration test in `tests/integration/webhooks.test.ts`:
  - authorize → mint → uninstall → tool call returns 401 (`invalid_token`, because merchant record is gone)
  - replay uninstall on already-deleted record → 200, no error (KV delete on missing key is a no-op)
  - install again (fresh `app.store.authorize`) → tool call now succeeds with a freshly minted URL

**Checkpoint**: After uninstall, every existing install URL returns 401 immediately. KV record is gone. Reinstall works cleanly.

---

## Phase 7: User Story 5 — Transparent Token Refresh (Priority: P2)

**Goal**: Proactively refresh Salla access tokens when they near expiry (default <60 min remaining) using a single-flight KV mutex. Salla rejects parallel refresh attempts (the docs are explicit), so the mutex is correctness-critical, not just an optimization.

**Independent Test**: Set `access_expires_at` to `now + 30 min` in a test MerchantRecord; make a tool call; assert the stored access_token has been replaced and the tool call succeeded. Send N concurrent tool calls at the same time with an expiring token; assert exactly one Salla refresh request was made.

- [ ] **T047** [US5] Implement `refreshSallaToken(storeId, env)` in `src/lib/refresh.ts` per `data-model.md §KV Access Patterns: Token Refresh` and `plan.md §4 Refresh Mutex`:
  - **Step 1 (acquire):** check `SALLA_TOKENS.get('refresh_lock:' + storeId)`. If present, return WAIT_PATH signal (caller enters wait loop in T048).
  - **Step 2 (set lock):** write `refresh_lock:{storeId} = "1"` with `{expirationTtl: 30}`.
  - **Step 3 (TOCTOU re-read):** re-read `store:{storeId}`. If `access_expires_at > now + refreshWindow`, another worker just succeeded — release lock, return existing token.
  - **Step 4 (refresh):** POST to `https://accounts.salla.sa/oauth2/token` with stored refresh token, `client_id`, `client_secret`, `grant_type=refresh_token`. Note: this response uses `expires` as **duration in seconds**, NOT absolute timestamp — convert with `Date.now() + expires * 1000`.
  - **Step 5 (success):** retain old refresh token in `previous_refresh_token_ct/iv` for one cycle (recovery from our KV write failures only — Salla itself does NOT have a grace window). Encrypt new tokens with current `key_version`. Write merchant record. Delete lock key explicitly.
  - **Step 6 (failure 4xx from Salla):** treat as unrecoverable. Update record with `status: 'refresh_failed'`. Delete lock key. Throw `RefreshFailedError`.
  - **Step 7 (failure 5xx/network):** delete lock key. Throw `RefreshTransientError` (caller may retry on next request).
  - On the *next* successful refresh, drop `previous_refresh_token_*` (it is now stale and Salla will reject it anyway).
- [ ] **T048** [US5] Implement wait-path logic in `src/lib/token-store.ts` `getValidSallaToken`:
  - When `access_expires_at - now < refreshWindow` (default 60 min, `env.REFRESH_WINDOW_SECONDS`), call `refreshSallaToken`.
  - If refresh returns WAIT_PATH: re-read merchant record up to 5 times with 200ms backoff between reads. After each read, check whether `access_expires_at` has advanced past the refresh window (indicating the holding worker succeeded). If yes, return the now-current token.
  - If after 5 retries (~1s) no advance: throw `RefreshInProgressError` (handler maps to HTTP 502 `refresh_in_progress` with `Retry-After: 2`).
  - If access token is *already past* `access_expires_at` and refresh is still in progress, treat the same: 502.
  - If `RefreshFailedError`: propagate up; auth middleware maps to HTTP 401 `reinstall_required` (per FR-021).
- [ ] **T049** [US5] Write unit tests in `tests/unit/refresh.test.ts`:
  - access token outside refresh window → no refresh called
  - access token inside refresh window → refresh called once, new tokens persisted, lock acquired then released
  - **TOCTOU re-read:** worker A sets lock; while A is mid-refresh, worker B arrives, finds lock, waits, observes that A's write already advanced the record — B uses the new token without making a duplicate Salla call
  - **N concurrent callers with expiring token:** exactly 1 Salla refresh request, all callers eventually succeed with the new token (mock Salla token endpoint to count calls)
  - Salla 4xx → `status` set to `refresh_failed`, lock released, throws `RefreshFailedError`
  - Salla 5xx → lock released, no status change, throws `RefreshTransientError`
  - Lock TTL: simulate Worker crash mid-refresh (lock left behind), wait 30s, next caller succeeds
  - **previous_refresh_token retention:** after a successful refresh, the previous refresh token is in `previous_refresh_token_ct`; after the *next* successful refresh, it is gone
  - **Refresh response parsing:** Salla token endpoint returns `expires` as duration seconds (NOT absolute timestamp); `access_expires_at` is correctly computed as `now + expires*1000`
- [ ] **T050** [US5] Write integration test in `tests/integration/refresh.test.ts`:
  - seed a MerchantRecord with `access_expires_at` 30 min from now → make a tool call → assert tool call succeeded AND the stored access token has been replaced
  - seed a MerchantRecord with an invalid refresh token → make a tool call → assert HTTP 401 with `reinstall_required` body, `status='refresh_failed'` in KV

**Checkpoint**: Token rotation is invisible to the MCP client. No tool call fails due to access token expiry in steady state. No merchant is ever locked out by parallel refresh attempts.

---

## Phase 8: User Story 6 — Scope-Filtered Tool Access (Priority: P2)

**Goal**: `tools/list` returns only tools allowed by the scope ceiling (intersection of JWT minted scopes and live Salla scopes); `tools/call` re-validates scopes server-side; `app.updated` — handled per the model selected in T006b — propagates scope changes.

**Independent Test**: Mint URL with `orders:read` only → `tools/list` excludes `update_order_status`; calling `update_order_status` returns HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="orders:write"`. After scope change (via `app.updated` or follow-up `app.store.authorize` per T006b model), next `tools/list` reflects new scope set.

- [ ] **T051** [US6] Implement `app.updated` handler in `src/webhooks/salla.ts` per the model selected in T006b:
  - **Notification-only model (preferred per Salla docs):** verify HMAC; parse storeId; read existing record; if absent log WARN and return 200; optionally update `updated_at`; return 200. Tokens and scopes will be updated by the follow-up `app.store.authorize` event.
  - **Token-bearing model (only if T006b empirical capture proves docs are misleading):** apply same logic as `app.store.authorize` (T025) including replay protection, but preserve `installed_at` and `active_jti`.
- [ ] **T052** [US6] Implement server-side scope re-validation in `src/mcp/handler.ts` `tools/call` dispatch:
  - Before invoking any tool handler, look up `tool.requiredScopes` from the registry.
  - Call `hasRequiredScopes(ctx.effectiveScopes, tool.requiredScopes)`.
  - If insufficient: return HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<space-joined required scopes>"` and JSON body `{error: "insufficient_scope", required: [...]}` per `contracts/mcp-endpoint.md`.
  - **This check runs even though `tools/list` already filtered.** Constitution principle 6 mandates two-layer enforcement.
- [ ] **T053** [US6] Write integration tests in `tests/integration/mcp-tools.test.ts` (extending T039):
  - mint URL with `orders:read` only → `tools/list` excludes `update_order_status`, `search_catalog`, etc.
  - call `update_order_status` (write tool) with a read-only URL → HTTP 403 with correct `WWW-Authenticate` header naming `orders:write`
  - **Scope ceiling test:** mint URL with `[orders:read]` for a merchant who has live scopes `[orders:read, products:read]`. Tools requiring `products:read` MUST be excluded — the JWT ceiling clamps the merchant's broader scopes.
  - **Scope shrink test:** simulate `app.updated` (or follow-up authorize per T006b) reducing merchant scopes; next `tools/list` reflects the reduction even though the JWT minted scopes are unchanged
  - **Scope expand attempt:** mint a URL with scopes greater than merchant's grant → mint endpoint returns 400 `invalid_scopes` (T032 check)

**Checkpoint**: Two-layer scope enforcement verified. Scope ceiling intersection correct in both expand and shrink directions.

---

## Phase 9: User Story 7 — Expired Refresh Token Recovery (Priority: P3)

**Goal**: When the Salla refresh token itself is rejected as unrecoverable, return HTTP 401 with a re-install prompt distinct from generic invalid-token 401.

**Independent Test**: Seed a MerchantRecord with a refresh token that Salla will reject (or set `status='refresh_failed'` directly) → make a tool call → assert HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token", error_description="..."` and JSON body `{error: "reinstall_required", detail: "..."}`. After a fresh `app.store.authorize` webhook, next tool call succeeds.

- [ ] **T054** [US7] Verify (or extend) `RefreshFailedError` propagation:
  - In `src/lib/refresh.ts` (T047 step 6): on Salla 4xx, sets `status='refresh_failed'` and throws `RefreshFailedError` — verify already done.
  - In `src/middleware/auth.ts` (T030): catches `RefreshFailedError` (or detects `status='refresh_failed'` directly on the merchant record) and returns HTTP 401 with `error_description="Reinstall the Salla MCP app to restore connectivity"` and JSON body `{error: "reinstall_required", detail: "The Salla refresh token has been invalidated. Please reinstall the Salla MCP app from the Salla App Store."}` per `contracts/mcp-endpoint.md §Error Code Summary`.
- [ ] **T055** [US7] Write integration test in `tests/integration/refresh.test.ts`:
  - seed `status='refresh_failed'` MerchantRecord → tool call → 401 `reinstall_required`
  - simulate `app.store.authorize` (clears the failed status, replaces tokens, sets `status='active'`) → next tool call succeeds
  - confirm `app.store.authorize` overwrite path correctly handles the recovery (does NOT preserve `status='refresh_failed'` from a prior install attempt)

**Checkpoint**: Merchant sees a clear, actionable error message. Re-install resets the connector cleanly.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Edge-case hardening, deployment configuration, observability validation, and security review.

- [ ] **T056** [P] Verify Salla API 429 forwarding in `src/lib/salla-client.ts` (T021): map Salla 429 to HTTP 429 `upstream_rate_limited` with `Retry-After` forwarded; add explicit test in `tests/integration/mcp-tools.test.ts` per FR-028 — system MUST NOT silently retry
- [ ] **T057** [P] Verify HTTP 404 responses on `/internal/mint` for unknown `store_id` (FR-029) and on `/internal/revoke` for unknown store (covered by T032/T041 but add an explicit integration test)
- [ ] **T058** [P] Create `docs/spec-deviations.md` with the documented deviations from MCP spec:
  - No OAuth Authorization Server façade (no `/authorize`, `/token`, `/register`, no PKCE, no DCR, no `/.well-known/oauth-authorization-server`)
  - No SSE / WebSocket transports (Streamable HTTP single-response only)
  - Token accepted as query parameter for compatibility with current dashboard URL format (FR-011)
  - One active install URL per merchant in v1 (multi-URL is v2)
  - No server-side `update_order_status` confirmation in v1 (description-level hint only)
  - For each deviation: rationale, observable symptom (e.g. "MCP client cannot auto-discover auth"), and reverse-migration path
- [ ] **T059** [P] Finalize production `wrangler.toml` environment block: real KV namespace IDs, Rate Limiting namespace, route pattern for production hostname
- [ ] **T060** [P] Write secret provisioning runbook in `docs/runbooks/secrets.md`: list every required secret, who provisions it, how to rotate (especially `INTERNAL_API_SECRET`, `SALLA_WEBHOOK_SECRET`, and `TOKEN_ENC_KEY` versioned rotation), and the order in which secrets must be set before first deploy. **No actual secret values in the runbook.**
- [ ] **T061** [P] Outline CI/CD pipeline in `docs/runbooks/ci.md`: which secret store to read from, how the deploy job invokes wrangler, how tests gate the deploy, how staging/production environments differ
- [ ] **T062** [P] Write smoke-test script in `scripts/smoke-test.sh`: runs against a deployed environment with a known test JWT and merchant; verifies `initialize`, `tools/list`, `whoami` succeed; alerts on failure
- [ ] **T063** Run full `quickstart.md` walkthrough end-to-end: webhook → mint → Claude Desktop connection → tool call. Measure Worker-added latency and confirm p99 <50 ms (SC-002)
- [ ] **T064** Security review checklist (each item is a separate verification, not a single task):
  - [ ] **T064a** `grep -r "access_token\|refresh_token\|signing_secret\|client_secret" src/ tests/` — no token values appear in any log call. Inspect each match.
  - [ ] **T064b** Verify no `TOKEN_ENC_KEY*` or `JWT_SIGNING_SECRET` value is ever written to KV. (Conceptually impossible given the code, but grep for `KV.put` calls and inspect each one.)
  - [ ] **T064c** Verify `effectiveScopes` enforcement is present on every `tools/call` path (T052). Audit `src/mcp/tools/*.ts` — no tool handler bypasses the registry's scope check.
  - [ ] **T064d** Verify the JWT_DENYLIST always uses hashed keys (`jti:{sha256(jti)}`) — grep for `JWT_DENYLIST.put`/`.get` and confirm every call uses the hashed form, never the raw jti.
  - [ ] **T064e** Verify `auth-internal.ts` uses `timingSafeEqualHex`, not `===`, for HMAC comparison (T014, T019).
  - [ ] **T064f** Verify all responses to authentication failures (401, 403) return generic error codes that do not distinguish "token format invalid" from "token not on denylist" from "merchant record absent" — these all return `invalid_token` per `contracts/mcp-endpoint.md`. Distinguishing them in error messages would leak merchant existence.

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)              → No dependencies — start immediately
Phase 2 (Foundational)       → Depends on Phase 1 — BLOCKS all user stories
   ├── T006a-f verification  → Must complete before T021, T022, T024, T025, T045, T051
   ├── Crypto/JWT/HMAC libs  → No external dependencies
   └── auth-internal middleware → Depends on hmac.ts (T010)
Phase 3 (US1)                → Depends on Phase 2 (crypto, jwt, logger, salla-client)
Phase 4 (US2)                → Depends on Phase 2 + Phase 3 (MerchantRecord must exist to mint URL)
Phase 5 (US3)                → Depends on Phase 4 (extends mint.ts; introduces revoke.ts)
Phase 6 (US4)                → Depends on Phase 3 (extends webhook handler)
Phase 7 (US5)                → Depends on Phase 4 (extends token-store.ts; refresh.ts is new)
Phase 8 (US6)                → Depends on Phase 4 (extends handler.ts and webhooks/salla.ts)
Phase 9 (US7)                → Depends on Phase 7 (extends refresh.ts behavior)
Phase 10 (Polish)            → Depends on Phases 3–9 complete
```

### User Story Dependencies

| Story | Depends On | Can Parallel With |
|-------|-----------|-------------------|
| US1 (P1) | Foundation | — |
| US2 (P1) | Foundation + US1 (needs MerchantRecord) | — |
| US3 (P2) | US2 (extends mint.ts) | US4, US5, US6 |
| US4 (P2) | US1 (extends webhook handler) | US3, US5, US6 |
| US5 (P2) | US2 (extends token-store.ts) | US3, US4, US6 |
| US6 (P2) | US2 (extends handler.ts) | US3, US4, US5 |
| US7 (P3) | US5 (extends refresh.ts) | — |

### Within Each User Story

1. Unit tests are written alongside implementation (required by constitution).
2. Implementation tasks producing new files can run in parallel where marked [P].
3. Integration wiring tasks depend on implementation being complete.
4. The story's integration test is the final task and the gate for moving on.

---

## Parallel Opportunities

### Phase 2 — Foundational (high parallelism)

```
Parallel group A (after T007):
  T008 — src/lib/crypto.ts
  T009 — src/lib/jwt.ts
  T010 — src/lib/hmac.ts
  T011 — src/lib/scope.ts
  T012 — src/middleware/logger.ts
  T013 — src/middleware/request-id.ts

Parallel group B (after group A; T014 depends on T010):
  T014 — src/middleware/auth-internal.ts

Parallel group C (after groups A, B):
  T015 — tests/unit/crypto.test.ts
  T016 — tests/unit/jwt.test.ts
  T017 — tests/unit/scope.test.ts
  T018 — tests/unit/hmac.test.ts
  T019 — tests/unit/auth-internal.test.ts
  T020 — tests/unit/logger.test.ts

Parallel group D (after T006a-f verification):
  T021 — src/lib/salla-client.ts
  T022 — src/constants.ts
```

### Phase 4 — US2 (largest phase)

```
Parallel group (after T029, T030):
  T033 — src/mcp/initialize.ts
  T034 — src/mcp/tools-list.ts
  T035 — src/mcp/tools/registry.ts
  T036 — src/mcp/tools/*.ts (7 tools)
```

---

## Implementation Strategy

### MVP (User Stories 1 + 2 only — Phases 1–4)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational including all T006* verification (CRITICAL — blocks everything)
3. Complete Phase 3: US1 — Webhooks & token storage
4. Complete Phase 4: US2 — Install URL minting + full MCP tool call flow
5. **STOP and VALIDATE**: `quickstart.md` walkthrough; Claude Desktop connection; `whoami` tool call against a real Salla demo store
6. Ship MVP: merchants can install and connect their AI client

### Incremental Delivery (add stories after MVP)

| Iteration | Stories Added | New Capability |
|-----------|--------------|---------------|
| MVP | US1, US2 | Install + connect; all 7 tools callable |
| Iteration 2 | US3, US4 | URL revocation + uninstall cleanup |
| Iteration 3 | US5, US6 | Token auto-refresh + scope updates |
| Iteration 4 | US7 | Graceful re-install prompt on expired refresh token |
| Polish | — | Edge cases, security hardening, perf validation |

### Parallel Team Strategy (2 developers after Phase 4)

- Dev A: US3 (revocation) + US4 (uninstall)
- Dev B: US5 (token refresh) + US6 (scope update)
- Both: merge → US7 → Polish

---

## Notes

- **[P]** = different files, no in-progress dependencies — safe to run in parallel
- **[Story]** label maps task to user story for traceability
- Constitution principle 10: unit tests **required** for all auth/token/webhook/scope code. Tests are not "added later."
- T006a–T006f are real-world verification steps — do not skip; T021, T022, T025, T045, T051 depend on their findings
- Each story phase should be independently demonstrable before moving to the next
- `whoami` tool is a zero-dependency smoke test; use it to verify any new install URL works
- The `update_order_status` confirmation hint is **description-only** in v1 — no server-side gating. Do not "improve" this without amending the spec and constitution first.
- Salla refresh tokens are **single-use with no grace window** — the mutex in T047/T048 is the only protection against parallel-refresh lockouts. Treat it as correctness-critical, not performance.
- The `expires` field has **two different meanings** depending on its source: absolute Unix timestamp in the `app.store.authorize` webhook, duration in seconds in the `/oauth2/token` refresh response. Do not share parsing logic between the two code paths.
