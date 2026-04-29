# Tasks: Salla Merchant MCP Server

**Input**: Design documents from `specs/001-salla-merchant-mcp/`  
**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ contracts/ ✅

**Tests**: Unit tests are **required** (not optional) per the project constitution: _"Any PR touching authentication, token storage, refresh, webhook verification, or scope enforcement MUST include unit tests."_ Test tasks are included below for all auth-critical paths.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on in-progress tasks)
- **[Story]**: Which user story this task belongs to (US1–US7)
- Exact file paths are included in every task description

---

## Phase 1: Setup (Project Initialization)

**Purpose**: Scaffold the Cloudflare Workers project. No dependencies — start immediately.

- [ ] T001 Initialize npm project: create `package.json` with dependencies (`hono`, `@modelcontextprotocol/sdk`, `zod`, `wrangler`) and devDependencies (`vitest`, `@cloudflare/vitest-pool-workers`, `typescript`)
- [ ] T002 [P] Configure TypeScript strict mode: create `tsconfig.json` with `"strict": true`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"lib": ["ESNext"]`
- [ ] T003 [P] Configure Wrangler: create `wrangler.toml` with KV namespace bindings (`SALLA_TOKENS`, `JWT_DENYLIST`), Rate Limiting binding (`RATE_LIMITER`, 60 req/60 s), route `GET|POST /v1/mcp`, and environment variable defaults
- [ ] T004 [P] Configure Vitest: create `vitest.config.ts` with `@cloudflare/vitest-pool-workers` pool so Workers APIs (KV, WebCrypto, Rate Limiting) are real in unit tests
- [ ] T005 [P] Create `.dev.vars` template and `.gitignore` entry; document required secrets (`ENCRYPTION_KEY`, `JWT_SIGNING_SECRET`, `SALLA_WEBHOOK_SECRET`, `INTERNAL_API_SECRET`, `SALLA_CLIENT_ID`, `SALLA_CLIENT_SECRET`) in a comment block

**Checkpoint**: `npx wrangler dev` starts with no errors; `npm test` runs (zero tests pass — that's expected here).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core libraries and infrastructure that every user story depends on. No user story work can begin until this phase is complete.

**⚠️ CRITICAL**: Complete and validate all foundational tasks before starting Phase 3.

- [ ] T006 Define `Env` interface (KV namespaces, Rate Limiting binding, all secrets) and shared TypeScript types (`MerchantRecord`, `InstallURLTokenPayload`, `StoreContext`) in `src/types.ts`
- [ ] T007 [P] Implement `encrypt(plaintext, env)` and `decrypt(ciphertext, env)` using AES-256-GCM via `crypto.subtle`; storage format: `base64(iv) + "." + base64(ciphertext+authTag)` in `src/lib/crypto.ts`
- [ ] T008 [P] Implement `signJWT(payload, secret)` and `verifyJWT(token, secret)` using HS256 via `crypto.subtle`; include `iss`, `aud`, `sub`, `jti`, `iat`, `exp`, `scope` claim handling in `src/lib/jwt.ts`
- [ ] T009 [P] Implement `scopeIntersection(jwtScopes, liveScopes)` and `hasRequiredScopes(effectiveScopes, requiredScopes)` in `src/lib/scope.ts`
- [ ] T010 [P] Implement structured logger middleware: `createLogger(c)` emitting JSON with allowlisted fields only (`store_id`, `jti`, `tool_name`, `status_code`, `latency_ms`); must reject any attempt to log token values in `src/middleware/logger.ts`
- [ ] T011 Write unit tests for `crypto.ts`: encrypt/decrypt round-trip, tamper detection (modified ciphertext throws), wrong key returns null, different IVs produce different ciphertext in `tests/unit/crypto.test.ts`
- [ ] T012 [P] Write unit tests for `jwt.ts`: sign/verify round-trip, expired token rejects, tampered payload rejects, wrong `aud` rejects, all required claims present in `tests/unit/jwt.test.ts`
- [ ] T013 [P] Write unit tests for `scope.ts`: intersection of overlapping scopes, empty intersection, whoami exemption (empty required scopes always passes), ceiling enforcement (JWT scope not in live scopes = excluded) in `tests/unit/scope.test.ts`
- [ ] T014 **[CONFIRM FIRST]** Verify Salla webhook signature header name, encoding format, and signed content per `research.md §S1`; confirm Salla API base URL, auth header format, and all 6 endpoint paths per `research.md §S3–S4`; confirm exact Salla scope strings per `research.md §S5`
- [ ] T015 Implement typed Salla API HTTP client with methods for all 6 tool endpoints and error mapping (5xx → 502, 429 → forward with Retry-After, 401 → trigger refresh) in `src/lib/salla-client.ts` *(depends on T014)*
- [ ] T016 Define `TOOL_SCOPE_MAP` and all Salla OAuth scope string constants in `src/constants.ts` *(depends on T014)*
- [ ] T017 Create Hono app with global error handler, 404 handler, and route stubs (webhooks, internal, MCP) in `src/index.ts`; export `default { fetch: app.fetch }` as Workers entry point

**Checkpoint**: All unit tests in `tests/unit/` pass (`npm test`). `wrangler dev` starts cleanly.

---

## Phase 3: User Story 1 — Merchant App Install & Token Storage (Priority: P1) 🎯 MVP

**Goal**: Receive Salla Easy Mode webhooks, verify signatures, and store encrypted merchant credentials in KV.

**Independent Test**: POST a simulated `app.store.authorize` webhook with valid HMAC signature → KV contains encrypted merchant record; replay identical webhook → same KV state (idempotency). POST with invalid signature → HTTP 403, KV unchanged.

- [ ] T018 [US1] Implement HMAC-SHA256 webhook signature verification using timing-safe comparison in `src/webhooks/salla.ts`; reject with HTTP 403 on failure before any handler runs *(depends on T014 for header name)*
- [ ] T019 [US1] Implement `app.store.authorize` handler: parse `merchant` (store_id), `data.access_token`, `data.refresh_token`, `data.expires_in`, `data.scope`; build `MerchantRecord`; encrypt; write to `SALLA_TOKENS` key `merchant:{storeId}` in `src/webhooks/salla.ts`
- [ ] T020 [US1] Write unit tests for HMAC verification: valid signature passes, invalid signature returns 403, missing signature returns 403, timing-safe comparison used in `tests/unit/webhook-verification.test.ts`
- [ ] T021 [US1] Write integration test for `app.store.authorize`: simulate signed webhook → assert `SALLA_TOKENS` contains decryptable record with correct fields; replay same webhook → same record (idempotent) in `tests/integration/webhooks.test.ts`

**Checkpoint**: Run integration test for US1. Simulate the webhook via `quickstart.md` step 4. Merchant record is stored and readable.

---

## Phase 4: User Story 2 — Install URL Generation & AI Client Connection (Priority: P1)

**Goal**: Mint a signed install URL via the internal API; MCP clients can initialize, list tools, and call tools using that URL.

**Independent Test**: POST to `/internal/mint` → get install URL; use token in `Authorization: Bearer` → `initialize` returns server info; `tools/list` returns tools matching minted scopes; `tools/call whoami` returns store context. Requires a MerchantRecord from US1.

- [ ] T022 [US2] Implement `getValidSallaToken(storeId, env)` — read `SALLA_TOKENS`, decrypt, return `{ accessToken, scopes }`; if record missing return null (token refresh not yet wired — added in US5) in `src/lib/token-store.ts`
- [ ] T023 [US2] Implement JWT auth middleware: extract token from `Authorization: Bearer` header (preferred) or `?token=` query param; verify HS256 signature; check `exp`; check `JWT_DENYLIST`; read `MerchantRecord`; compute `effectiveScopes = jwtScope ∩ liveScopes`; apply `RATE_LIMITER.limit({key: jti})`; inject `StoreContext` into Hono context in `src/middleware/auth.ts`
- [ ] T024 [US2] Write unit tests for auth middleware covering: valid token flow, expired JWT returns 401 + WWW-Authenticate, revoked JTI (in denylist) returns 401, missing merchant record returns 401, rate limit exceeded returns 429 + Retry-After in `tests/unit/auth.test.ts`
- [ ] T025 [US2] Implement `/internal/mint` endpoint: verify `INTERNAL_API_SECRET`; read `MerchantRecord`; return 404 if store not found; sign new JWT (`jti = crypto.randomUUID()`, 90-day exp, minted scopes as ceiling); write `active_jti` to merchant record; return `{ install_url, jti, expires_at }` in `src/internal/mint.ts` *(atomic revocation of previous JTI added in US3)*
- [ ] T026 [P] [US2] Implement `initialize` response builder (server name, version, capabilities) in `src/mcp/initialize.ts`
- [ ] T027 [P] [US2] Implement `tools/list` response: filter `TOOL_SCOPE_MAP` by `effectiveScopes`; always include `whoami`; return MCP-formatted tool list with full Zod-derived JSON schemas in `src/mcp/tools-list.ts`
- [ ] T028 [US2] Implement per-request MCP Streamable HTTP handler: instantiate fresh `McpServer`, dispatch `initialize` / `tools/list` / `tools/call` methods, return single JSON response in `src/mcp/handler.ts`
- [ ] T029 [P] [US2] Implement all 7 MCP tool handlers with Zod input validation (`list_orders`, `get_order`, `update_order_status`, `search_catalog`, `get_inventory_levels`, `get_shipment_tracking`, `whoami`) in `src/mcp/tools/*.ts` and register in `src/mcp/tools/registry.ts`
- [ ] T030 [US2] Wire all routes into Hono app: `POST /v1/mcp` and `GET /v1/mcp` (both behind auth middleware), `POST /internal/mint` in `src/index.ts`
- [ ] T031 [US2] Write integration test for US2: authorize webhook → mint URL → `initialize` → `tools/list` → `whoami` tool call; assert correct store_id and effective_scopes returned in `tests/integration/mcp-tools.test.ts`

**Checkpoint**: Run `quickstart.md` steps 4–6 in full. Claude Desktop can connect, list tools, and call `whoami`.

---

## Phase 5: User Story 3 — Install URL Revocation & Regeneration (Priority: P2)

**Goal**: Revoke an install URL immediately via the internal API; minting a new URL atomically revokes the previous one.

**Independent Test**: Mint URL A → revoke URL A → tool call with URL A returns 401; mint URL B → tool call with URL B succeeds; URL A still returns 401.

- [ ] T032 [US3] Implement `/internal/revoke` endpoint: verify `INTERNAL_API_SECRET`; validate `store_id` and `jti`; return 404 if `jti` is not the current `active_jti`; write `{jti}` to `JWT_DENYLIST` with TTL = JWT expiry; set `MerchantRecord.active_jti = null` in `src/internal/revoke.ts`
- [ ] T033 [US3] Update `/internal/mint` to atomically revoke previous `active_jti`: before issuing new JWT, if `MerchantRecord.active_jti` is non-null write it to `JWT_DENYLIST` with its original expiry TTL in `src/internal/mint.ts`
- [ ] T034 [US3] Wire `POST /internal/revoke` route in `src/index.ts`
- [ ] T035 [US3] Write integration test: mint URL A → revoke URL A → assert tool call returns 401; mint URL B → assert tool call with B succeeds; confirm URL A still returns 401 in `tests/integration/mint-revoke.test.ts`

**Checkpoint**: Revocation works immediately. Old URL is dead; new URL works. Salla tokens untouched.

---

## Phase 6: User Story 4 — App Uninstall & Full Cleanup (Priority: P2)

**Goal**: Delete all merchant credentials when `app.store.uninstalled` fires; all install URLs stop working immediately without needing denylist entries.

**Independent Test**: Authorize → mint URL → `app.store.uninstalled` webhook → tool call returns 401; replay uninstall webhook → no error (idempotent).

- [ ] T036 [US4] Implement `app.store.uninstalled` handler: verify HMAC signature; delete `SALLA_TOKENS` key `merchant:{storeId}`; return HTTP 200 in `src/webhooks/salla.ts`
- [ ] T037 [US4] Write integration test for uninstall: authorize → mint → uninstall → confirm tool call returns 401 (no merchant record); replay uninstall → confirm no error in `tests/integration/webhooks.test.ts`

**Checkpoint**: After uninstall, every existing install URL returns 401. KV record is gone.

---

## Phase 7: User Story 5 — Transparent Token Refresh (Priority: P2)

**Goal**: Proactively refresh Salla access tokens when they near expiry (<60 min remaining) using a single-flight best-effort KV lock; the install URL never changes.

**Independent Test**: Set `token_expires_at` to `now + 30 min` in a test MerchantRecord; make a tool call; assert the stored token has been updated and the tool call succeeded. Send two concurrent tool calls at the same time with an expiring token; assert only one refresh request was made to Salla.

- [ ] T038 [US5] Implement `refreshSallaToken(storeId, env)` in `src/lib/refresh.ts`: acquire best-effort KV lock (`refresh_lock:{storeId}`, TTL 30 s); call Salla OAuth token refresh endpoint with stored refresh_token; update `MerchantRecord` with new tokens on success; release lock; if Salla returns 4xx throw `UnrecoverableRefreshError`
- [ ] T039 [US5] Update `getValidSallaToken` in `src/lib/token-store.ts`: check if `token_expires_at - now < 60 min` (configurable via `env.REFRESH_WINDOW_SECONDS`); if so call `refreshSallaToken`; if lock already held (another request is refreshing), wait 200 ms and re-read the record
- [ ] T040 [US5] Write unit tests for `token-store.ts` and `refresh.ts`: token not near expiry → no refresh called; token near expiry → refresh called once; concurrent calls with expiring token → refresh called exactly once (lock prevents second call); `UnrecoverableRefreshError` propagates as HTTP 401 in `tests/unit/token-store.test.ts`

**Checkpoint**: Token rotation is invisible to the MCP client. No tool call fails due to expiry in steady state.

---

## Phase 8: User Story 6 — Scope-Filtered Tool Access (Priority: P2)

**Goal**: `tools/list` returns only permitted tools; `tools/call` re-validates scopes server-side; `app.updated` updates scopes live without disrupting active install URLs.

**Independent Test**: Mint URL with `orders:read` only → `tools/list` excludes `update_order_status`; calling `update_order_status` returns HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="orders:write"`. Send `app.updated` with new scopes → next `tools/list` reflects new scope set.

- [ ] T041 [US6] Implement `app.updated` handler: verify HMAC; read existing `MerchantRecord`; overwrite `access_token`, `refresh_token`, `token_expires_at`, `scopes`, `updated_at`; preserve `active_jti` and `installed_at`; write back in `src/webhooks/salla.ts`
- [ ] T042 [US6] Implement server-side scope re-validation in `tools/call` dispatch inside `src/mcp/handler.ts`: before calling any tool, check `hasRequiredScopes(effectiveScopes, tool.requiredScopes)`; if insufficient return HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<required>"` header
- [ ] T043 [US6] Write integration test for scope filtering: mint URL with `orders:read` → `tools/list` excludes write tools → call `update_order_status` → assert HTTP 403 with correct `WWW-Authenticate` header in `tests/integration/mcp-tools.test.ts`

**Checkpoint**: Scope ceiling enforced at both layers. Scope update via `app.updated` is reflected immediately on next request.

---

## Phase 9: User Story 7 — Expired Refresh Token Recovery (Priority: P3)

**Goal**: When the Salla refresh token itself is rejected (unrecoverable), return HTTP 401 with a re-install prompt distinct from the generic invalid-token 401.

**Independent Test**: Inject an invalid refresh token into a MerchantRecord; make a tool call that triggers refresh; assert HTTP 401 with body `{ "error": "refresh_token_expired", "action": "reinstall" }`.

- [ ] T044 [US7] Update `refreshSallaToken` in `src/lib/refresh.ts` to handle `UnrecoverableRefreshError`: catch Salla 4xx on refresh, return HTTP 401 with JSON body `{ "error": "refresh_token_expired", "action": "reinstall" }` and `WWW-Authenticate: Bearer error="invalid_token"` header
- [ ] T045 [US7] Write integration test for US7: set invalid refresh_token in KV; make tool call that triggers refresh; assert HTTP 401 with re-install body; simulate `app.store.authorize` (re-install) → assert next tool call succeeds in `tests/integration/mcp-tools.test.ts`

**Checkpoint**: Merchant sees a clear error message prompting re-installation. After re-install webhook, connector resumes normal operation.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Edge-case hardening, deployment configuration, and final validation.

- [ ] T046 [P] Add dual-source token conflict handling in `src/middleware/auth.ts`: when token is present in both `Authorization` header and `?token=` query param and they differ, use header value and emit WARN log with JTI only (no token values) per FR-027
- [ ] T047 [P] Verify Salla API 429 forwarding in `src/lib/salla-client.ts`: map Salla HTTP 429 response to HTTP 429 with `Retry-After` header forwarded to MCP client; do NOT silently retry per FR-028
- [ ] T048 [P] Add HTTP 404 responses for unknown `store_id` (mint) and unknown/non-active `jti` (revoke) to `src/internal/mint.ts` and `src/internal/revoke.ts` per FR-029
- [ ] T049 [P] Validate `docs/spec-deviations.md` is complete and accurate (4 deviations: no OAuth AS façade, no SSE/WebSocket, query-param token compat, no protected resource metadata discovery) *(already created in planning phase — verify content)*
- [ ] T050 [P] Add production `wrangler.toml` environment block with real KV namespace IDs, Rate Limiting namespace, and route pattern for `mcp.salla.dev`
- [ ] T051 Run full `quickstart.md` walkthrough end-to-end: webhook → mint → Claude Desktop connection → `list_orders` call; measure Worker-added latency and confirm p99 <50 ms
- [ ] T052 Security review: grep for token values in log calls; verify no `access_token` or `refresh_token` fields appear in any log output; confirm `ENCRYPTION_KEY` never written to KV or response bodies; confirm `effectiveScopes` enforcement present on every `tools/call` handler

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)          → No dependencies — start immediately
Phase 2 (Foundational)   → Depends on Phase 1 — BLOCKS all user stories
Phase 3 (US1)            → Depends on Phase 2 (crypto, jwt, logger, salla-client)
Phase 4 (US2)            → Depends on Phase 2 + Phase 3 (MerchantRecord must exist to mint URL)
Phase 5 (US3)            → Depends on Phase 4 (extends mint.ts; needs denylist)
Phase 6 (US4)            → Depends on Phase 3 (extends webhook handler)
Phase 7 (US5)            → Depends on Phase 4 (extends token-store.ts)
Phase 8 (US6)            → Depends on Phase 4 (extends handler.ts and webhooks/salla.ts)
Phase 9 (US7)            → Depends on Phase 7 (extends refresh.ts)
Phase 10 (Polish)        → Depends on Phases 3–9 complete
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

1. Unit tests for new code (written alongside implementation — required by constitution)
2. Implementation tasks that produce new files can run in parallel [P]
3. Integration wiring tasks depend on implementation being complete
4. Integration test is the final task for each story

---

## Parallel Opportunities

### Phase 2 — Foundational (run all [P] tasks together)

```
Parallel group A (can start immediately):
  T007 — src/lib/crypto.ts
  T008 — src/lib/jwt.ts
  T009 — src/lib/scope.ts
  T010 — src/middleware/logger.ts

Parallel group B (after T007–T010):
  T011 — tests/unit/crypto.test.ts
  T012 — tests/unit/jwt.test.ts
  T013 — tests/unit/scope.test.ts
```

### Phase 4 — US2 (largest phase; high parallelism)

```
Parallel group (after T022, T023):
  T026 — src/mcp/initialize.ts
  T027 — src/mcp/tools-list.ts
  T029 — src/mcp/tools/*.ts (all 7 tools)
```

---

## Implementation Strategy

### MVP (User Stories 1 + 2 only — Phases 1–4)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks everything)
3. Complete Phase 3: US1 — Webhooks & token storage
4. Complete Phase 4: US2 — Install URL minting + full MCP tool call flow
5. **STOP and VALIDATE**: `quickstart.md` walkthrough; Claude Desktop connection; `whoami` tool call
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
- Constitution principle 10: unit tests **required** for all auth/token/webhook/scope code
- T014 is a real-world confirm step (Salla developer portal) — do not skip; T015 and T016 depend on it
- `docs/spec-deviations.md` was created during planning — T049 is a verification task only
- Each story phase should be independently demonstrable before moving to the next
- `whoami` tool is zero-dependency smoke test; use it to verify any new install URL works
