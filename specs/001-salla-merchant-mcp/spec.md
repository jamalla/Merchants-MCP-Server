# Feature Specification: Salla Merchant MCP Server

**Feature Branch**: `001-salla-merchant-mcp`  
**Created**: 2026-04-29  
**Status**: Draft  

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Merchant App Install & Token Storage (Priority: P1)

A merchant installs the Salla MCP app from the Salla App Store. Salla's Hydra OAuth server immediately pushes an `app.store.authorize` webhook to the MCP server. The system verifies the webhook signature and stores the merchant's Salla access and Salla refresh tokens server-side in encrypted form — the merchant does nothing beyond clicking "Install." The merchant then sees a confirmation in their Salla Dashboard that the connector is active and ready.

**Why this priority**: This is the foundational event that bootstraps the entire system. Without token storage there is no way to call the Salla API on behalf of the merchant, so every other story depends on it.

**Independent Test**: Can be fully tested by simulating a valid `app.store.authorize` webhook and confirming that encrypted tokens are stored and the Dashboard confirmation state is set. Delivers the core value of zero-friction onboarding.

**Acceptance Scenarios**:

1. **Given** a merchant clicks Install in the App Store, **When** Salla sends `app.store.authorize` with a valid HMAC signature, **Then** the system stores the Salla access token and Salla refresh token encrypted, records granted scopes, and returns HTTP 200 to Salla.
2. **Given** the system receives `app.store.authorize`, **When** the HMAC signature is invalid or missing, **Then** the system rejects the webhook with HTTP 403 and stores nothing.
3. **Given** the same `app.store.authorize` event is replayed (duplicate delivery), **When** the system processes it a second time, **Then** the stored state is identical to after the first processing (idempotent).

---

### User Story 2 - Install URL Generation & AI Client Connection (Priority: P1)

A merchant opens the connector widget in their Salla Dashboard, clicks "Generate Install URL," and copies the URL. They paste it into Claude Desktop's "Add custom connector" field. From that point on, they can ask Claude about their orders, products, inventory, and shipments in natural language, and Claude can take actions like updating an order's status on their behalf.

**Why this priority**: This is the primary user-facing activation step. Without a valid install URL there is no way for an MCP client to connect, so all conversational commerce capability is blocked.

**Independent Test**: Can be fully tested by calling the internal mint endpoint, pasting the returned URL into an MCP client, running `tools/list`, and verifying tools appear. Delivers the complete conversation-to-store connection.

**Acceptance Scenarios**:

1. **Given** an authenticated Dashboard backend calls the internal mint endpoint, **When** the request is valid, **Then** the system returns a signed install URL with a 90-day lifetime and an opaque revocation identifier.
2. **Given** a valid install URL, **When** an MCP client calls `initialize`, **Then** the server responds with protocol metadata and a filtered tool list matching the merchant's scopes.
3. **Given** a valid install URL, **When** an MCP client calls `tools/list`, **Then** only tools permitted by the merchant's granted scopes are returned.
4. **Given** a valid install URL, **When** an MCP client calls `tools/call` with a permitted tool, **Then** the system calls the Salla API on behalf of the merchant and returns the result.

---

### User Story 3 - Install URL Revocation & Regeneration (Priority: P2)

A merchant who suspects their install URL has leaked opens the connector widget and clicks "Regenerate." The system immediately revokes the old URL; any request using it fails from that moment. A new URL is generated. The merchant's Salla tokens are untouched — only the install URL credential changes.

**Why this priority**: This is the primary security recovery path. Merchants need confidence that a compromised URL can be invalidated instantly without requiring a full app re-install.

**Independent Test**: Can be fully tested by revoking an install URL via the internal revoke endpoint, then attempting a tool call with the old URL and verifying HTTP 401 is returned. New URL must still work.

**Acceptance Scenarios**:

1. **Given** an existing install URL, **When** the Dashboard backend calls the revoke endpoint with its opaque identifier, **Then** the system marks it revoked and returns HTTP 200.
2. **Given** a revoked install URL, **When** an MCP client uses it on any request, **Then** the system returns HTTP 401 with a `WWW-Authenticate` header indicating an invalid token.
3. **Given** the same revoke request is replayed, **When** the system processes it a second time, **Then** the URL remains revoked and the response is identical (idempotent).
4. **Given** an install URL is revoked, **When** the merchant generates a new one, **Then** the new URL works and the merchant's Salla tokens are unchanged.

---

### User Story 4 - App Uninstall & Full Cleanup (Priority: P2)

A merchant uninstalls the Salla MCP app from the App Store. All install URLs tied to that merchant stop working immediately. The merchant's stored tokens are deleted from the system.

**Why this priority**: Correct cleanup on uninstall is required for data minimisation and compliance. Lingering tokens for an uninstalled app represent a security risk.

**Independent Test**: Can be fully tested by simulating `app.store.uninstalled`, then attempting a tool call with any previously valid install URL and confirming HTTP 401 is returned and no merchant records remain in storage.

**Acceptance Scenarios**:

1. **Given** a merchant's record exists with install URLs in circulation, **When** Salla sends `app.store.uninstalled` with a valid signature, **Then** the merchant's record (Salla tokens and granted scopes) is deleted, and HTTP 200 is returned.
2. **Given** the uninstall webhook arrives twice (duplicate delivery), **When** the system processes it a second time, **Then** the final state is identical to after the first processing (idempotent, no error).
3. **Given** an install URL from an uninstalled merchant, **When** an MCP client uses it, **Then** the system returns HTTP 401 because no merchant tokens exist for the store referenced by the URL.

---

### User Story 5 - Transparent Token Refresh (Priority: P2)

A merchant continues using their AI assistant indefinitely. Roughly every 14 days, the merchant's Salla access token nears expiry. The system detects this, refreshes the token using the stored Salla refresh token in a single-flight operation, and continues serving tool calls — the merchant never notices and the install URL never changes.

**Why this priority**: Long-term reliability requires seamless token rotation. Without this, every merchant would need to re-install every 14 days, making the product unusable as a persistent connector.

**Independent Test**: Can be fully tested by setting a Salla access token near its expiry window, sending a tool call, and verifying the stored token is updated and the tool call succeeds without any 401 from the Salla API.

**Acceptance Scenarios**:

1. **Given** a merchant's Salla access token is within the refresh window, **When** any tool call arrives, **Then** the system refreshes the token before calling the Salla API and updates the stored token on success.
2. **Given** two concurrent tool calls arrive when the Salla access token needs refresh, **When** both are processed simultaneously, **Then** only one refresh request is sent to Salla; the second waits and uses the refreshed token.
3. **Given** the Salla refresh token has been revoked or expired, **When** the system attempts a refresh, **Then** the tool call fails with HTTP 401 and a message prompting the merchant to re-install.
4. **Given** a token refresh has just produced a new Salla refresh token but the new token has not yet been used, **When** a transient failure causes the system to retry the refresh, **Then** the system may safely use either the old or the new refresh token; at least one of them MUST still be accepted by Salla until the new one has been successfully used.

---

### User Story 6 - Scope-Filtered Tool Access (Priority: P2)

An MCP client lists tools and receives only those the merchant's currently granted scopes permit. If the AI attempts to call a tool outside the merchant's scopes, it receives a clear permission error with the scopes needed, allowing the AI to surface a meaningful message rather than fail silently.

**Why this priority**: Scope enforcement is a core security and UX guarantee. Over-broad tool lists create confusion and potential API errors; under-enforcement is a security violation.

**Independent Test**: Can be fully tested with a merchant who has only order-read scope; verify that product-write tools are absent from `tools/list` and that calling one returns HTTP 403.

**Acceptance Scenarios**:

1. **Given** a merchant with only `orders:read` scope, **When** the MCP client calls `tools/list`, **Then** only order-reading tools appear in the response.
2. **Given** a merchant without `orders:write` scope, **When** the MCP client calls `update_order_status`, **Then** the system returns HTTP 403 with a `WWW-Authenticate` header listing the required scopes.
3. **Given** the merchant's scopes were updated by `app.updated`, **When** the MCP client next calls `tools/list`, **Then** the tool list reflects the new scope set.

---

### User Story 7 - Expired Refresh Token Recovery (Priority: P3)

A merchant whose Salla refresh token has been revoked or has expired encounters an unrecoverable auth state. Their next tool call fails with an HTTP 401 response indicating they must re-install the app. After re-installing, the `app.store.authorize` webhook delivers fresh tokens, and the connector works again.

**Why this priority**: This edge case is rare but must be handled gracefully with a clear recovery path so merchants are not left in a broken state without instructions.

**Independent Test**: Can be fully tested by invalidating the refresh token in the stored record, sending a tool call, and verifying HTTP 401 with a re-install prompt is returned.

**Acceptance Scenarios**:

1. **Given** a merchant's Salla refresh token is expired or revoked, **When** any tool call triggers a refresh attempt, **Then** the system returns HTTP 401 with a message indicating the merchant must re-install the MCP app.
2. **Given** the merchant re-installs the app, **When** Salla sends a fresh `app.store.authorize` webhook, **Then** the new tokens are stored and the connector resumes normal operation.

---

### Edge Cases

- A webhook is replayed with an identical payload (Salla at-least-once delivery) — addressed by FR-006.
- A refresh attempt fails after the access token has already expired (both tokens effectively dead) — addressed by FR-021 and User Story 7.
- Multiple concurrent tool calls from the same merchant arrive exactly when a refresh is triggered — addressed by FR-019.
- The Salla API responds with HTTP 429 (rate limit) during a tool call — addressed by FR-028.
- The install URL token appears in both the `Authorization` header and the query parameter simultaneously — addressed by FR-027.
- A merchant re-installs the app after uninstalling — addressed by FR-030 (revocation identifiers are never reused).
- The internal mint or revoke endpoints are called with an unknown or deleted store identifier — addressed by FR-029.

## Requirements *(mandatory)*

### Functional Requirements

**Webhook Handling**

- **FR-001**: System MUST receive Salla webhook events for `app.store.authorize`, `app.updated`, and `app.store.uninstalled` at a dedicated public endpoint.
- **FR-002**: System MUST verify the HMAC-SHA256 signature of every incoming webhook before processing; webhooks with missing, malformed, or invalid signatures MUST be rejected with HTTP 403 and no state changes. (Webhook delivery is signature-authenticated; HTTP 403 communicates "request understood and rejected on auth grounds," distinct from the HTTP 401 returned for missing or invalid MCP install URL tokens.)
- **FR-003**: On a valid `app.store.authorize` event, system MUST encrypt and store the merchant's Salla access token, Salla refresh token, token expiry, and granted scope set, keyed by store identifier.
- **FR-004**: On a valid `app.updated` event, system MUST overwrite the stored Salla tokens and scopes while preserving all existing install URL records and their revocation state.
- **FR-005**: On a valid `app.store.uninstalled` event, system MUST delete all merchant records, including Salla tokens and granted scopes. Subsequent requests using any install URL previously issued for that merchant MUST fail with HTTP 401 due to the absence of merchant tokens; no separate per-install-URL revocation step is required.
- **FR-006**: All three webhook handlers MUST be idempotent; replaying an identical event MUST produce the same final state without error.

**Install URL Management**

- **FR-007**: System MUST expose an internal endpoint (accessible only to the Salla Dashboard backend) that mints a signed install URL for a given store ID and scope set.
- **FR-008**: Each minted install URL token MUST have a configurable lifetime defaulting to 90 days, embed the store identifier, and carry an opaque revocation identifier unique to that issuance. A merchant MAY have at most one active install URL at a time; minting a new URL MUST atomically revoke the merchant's previous active URL (if any) before issuing the new one.
- **FR-009**: System MUST expose an internal endpoint (accessible only to the Salla Dashboard backend) to revoke a specific install URL by its opaque revocation identifier; revocation MUST take effect immediately and permanently.

**MCP Protocol Endpoint**

- **FR-010**: System MUST expose one MCP endpoint that implements the MCP Streamable HTTP transport in stateless mode; every request MUST be fully independent with no per-connection state.
- **FR-011**: The MCP endpoint MUST accept the signed install URL token via the `Authorization: Bearer <token>` header (preferred) or as a URL query parameter for dashboard URL format compatibility.
- **FR-012**: The MCP endpoint MUST implement the `initialize`, `tools/list`, and `tools/call` MCP methods.
- **FR-013**: On every inbound MCP request, system MUST validate the install URL token for authenticity, expiry, and revocation status before performing any other processing.

**Tools**

- **FR-014**: System MUST provide the following MCP tools, each with a fully typed input schema:
  - `list_orders` — list merchant orders with filter parameters (status, date range, page)
  - `get_order` — fetch a single order by ID
  - `update_order_status` — update an order's status; the tool description MUST encourage the AI client to obtain user confirmation before invocation, but the system does NOT enforce server-side confirmation in v1 (see Assumptions for elicitation roadmap)
  - `search_catalog` — search the merchant's product catalog by keyword or category
  - `get_inventory_levels` — fetch inventory levels for specified products or SKUs
  - `get_shipment_tracking` — fetch shipment tracking details for a given order or shipment ID
  - `whoami` — diagnostic tool that returns the current store identifier, the install URL revocation identifier, and the merchant's currently granted scopes; included to enable manual smoke-testing of new connections
- **FR-015**: `tools/list` MUST return only those tools whose required scopes are a subset of the **effective scope set** for the request. The effective scope set is the intersection of the merchant's currently granted Salla scopes (live from MerchantRecord) and the install URL's minted scope set (carried in the signed token). The install URL's minted scope set acts as a ceiling: a URL minted for `orders:read` cannot expose `products:write` tools even if the merchant later gains that scope. The `whoami` tool MUST be returned regardless of scope set, since it carries no merchant data beyond identity metadata.
- **FR-016**: Every `tools/call` invocation MUST re-validate the effective scope set server-side before calling the Salla API, regardless of what was returned by `tools/list`. The effective scope set is the intersection of the merchant's current Salla scopes and the install URL's minted scope set.
- **FR-017**: Tool inputs that fail schema validation MUST be rejected with HTTP 400 and a sanitized error message containing no merchant data, tokens, or internal state.

**Token Lifecycle**

- **FR-018**: System MUST detect when a merchant's Salla access token has fewer than 60 minutes remaining until expiry and proactively refresh it before calling the Salla API. The 60-minute threshold MUST be configurable via environment variable to allow adjustment without a code deploy.
- **FR-019**: Salla token refresh MUST be single-flight per merchant; if a refresh is already in progress, concurrent callers MUST wait for the in-progress refresh to complete and then use the resulting token.
- **FR-020**: Salla token refresh MUST implement a grace window such that the previous Salla refresh token remains accepted until the new Salla refresh token has been successfully used at least once, protecting against transient failures.
- **FR-021**: If the Salla token refresh endpoint rejects the Salla refresh token (unrecoverable), system MUST return HTTP 401 with a message indicating the merchant must re-install the MCP app.

**Error Handling**

- **FR-022**: A missing, malformed, expired, or revoked install URL token MUST produce HTTP 401 with a `WWW-Authenticate` header indicating `error="invalid_token"`.
- **FR-023**: A tool call requiring a scope not held by the merchant MUST produce HTTP 403 with a `WWW-Authenticate` header indicating `error="insufficient_scope"` and listing the required scopes.
- **FR-024**: A Salla API error (5xx) MUST be surfaced as HTTP 502; where the Salla response includes retry guidance, a `Retry-After` header MUST be forwarded.

**Edge-Case Handling**

- **FR-027**: When the install URL token is present in both the `Authorization` header and a URL query parameter, the system MUST use the header value and ignore the query parameter. If the two values are non-empty and differ, the system MUST log a warning at WARN level recording only the install URL revocation identifier of the header value (without including either token value).
- **FR-028**: When the Salla API responds with HTTP 429, the system MUST surface the response to the MCP client as HTTP 429 with the `Retry-After` header forwarded if present. The system MUST NOT silently retry the call.
- **FR-029**: The internal mint and revoke endpoints MUST return HTTP 404 when called with an unknown store identifier (mint) or an unknown install URL revocation identifier (revoke).
- **FR-030**: Install URL revocation identifiers MUST be globally unique and never reused, including across uninstall/reinstall cycles for the same store.

**Rate Limiting**

- **FR-031**: The MCP endpoint MUST enforce per-install-URL rate limiting on all tool calls. The default limit is 60 requests per minute per install URL revocation identifier, configurable at deploy time. Rate limiting MUST be implemented using the platform's native Rate Limiting binding (not a KV counter) so that counter increments do not constitute KV writes and the zero-KV-writes-in-steady-state guarantee of SC-006 is preserved. Requests exceeding the limit MUST be rejected with HTTP 429 and a `Retry-After` header before any call to the Salla API. The rate limit gate runs after install URL authentication and before tool dispatch. Rate limiting applies to MCP tool calls only; webhook endpoints and internal mint/revoke endpoints are exempt. All tools, including `whoami`, count against the per-URL limit equally.

**Observability**

- **FR-025**: System MUST emit a structured log entry for every tool call containing: store identifier, install URL revocation identifier, tool name, HTTP result status, and request latency in milliseconds.
- **FR-026**: Log entries MUST NOT contain Salla access tokens, Salla refresh tokens, install URL tokens, signing secrets, client secrets, or any merchant PII.

### Key Entities

- **MerchantRecord**: Represents one store's installation of the Salla MCP app. Holds the store identifier, encrypted Salla access token, encrypted Salla refresh token, token expiry timestamp, and the set of granted API scopes. Created on `app.store.authorize`, updated on `app.updated`, deleted on `app.store.uninstalled`.

- **InstallURL**: A signed, revocable credential that allows one MCP client to connect on behalf of one merchant. Exactly one InstallURL per merchant may be in `active` state at any time; minting a new one atomically revokes the previous. Holds an opaque revocation ID, a reference to the merchant's store, the minted scope set (embedded in the signed token; acts as a ceiling on what tools this URL can access — effective tool access is always the intersection of the merchant's current Salla scopes and this minted set), an issuance timestamp, and an expiry timestamp. The minted scope set is self-contained in the token and requires no separate storage read at request time. May be in `active` or `revoked` state.

- **WebhookEvent**: An inbound signed notification from Salla carrying an event type, store context, token payload, and HMAC signature for verification.

- **ToolCallLog**: An immutable audit record emitted for each MCP tool invocation, containing store identifier, install URL revocation identifier, tool name, result status code, and latency in milliseconds. Contains no sensitive data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A merchant completes the full journey — app install to first successful AI tool call — in under 5 minutes with no manual token handling.
- **SC-002**: Worker-added latency per tool call (excluding time spent waiting on the Salla API) is under 50 milliseconds at p99 under normal load.
- **SC-003**: Salla token refresh is invisible to merchants: zero tool calls fail due to access token expiry in steady-state operation (i.e., when the refresh token is valid).
- **SC-004**: Install URL revocation takes effect within one request cycle; no request using a revoked URL succeeds after the revocation call returns.
- **SC-005**: Replaying any webhook event (`app.store.authorize`, `app.updated`, `app.store.uninstalled`) produces the same stored state as the first delivery — no duplicate records, no errors.
- **SC-006**: In steady state, each tool call reads at most two KV storage records (one revocation check, one MerchantRecord fetch) and writes zero KV records; one write occurs at the approximately 14-day Salla token refresh boundary. Per-URL rate limiting counters (FR-031) are maintained by the platform's native Rate Limiting binding and do not count as KV reads or writes.
- **SC-007**: Under concurrent load, a single merchant never triggers more than one simultaneous Salla token refresh request.
- **SC-008**: Every error response includes a machine-readable HTTP status code and a human-readable message sufficient for an MCP client to surface actionable guidance to the merchant.
- **SC-009**: The MCP server achieves 99.9% monthly uptime (~43 minutes allowable downtime per calendar month), measured from the perspective of successful MCP endpoint responses excluding planned maintenance windows communicated in advance.

## Assumptions

- The Salla Dashboard backend authenticates itself to the internal mint and revoke endpoints via a pre-shared secret or network-level restriction; the exact mechanism is owned by the Dashboard team and is not part of this system's implementation.
- The encrypted storage backend (key-value store or similar) is provisioned and managed externally to this service; this spec does not dictate the storage technology.
- The install URL signing key and webhook verification secret are injected at deploy time via environment variables and are never logged or included in responses.
- Salla Hydra Easy Mode guarantees at-least-once webhook delivery; the idempotency requirement in FR-006 protects against duplicate processing.
- Merchants are fully authenticated to the Salla Dashboard before interacting with the connector widget; authentication to the Dashboard itself is out of scope.
- The `update_order_status` tool's description encourages the AI client to obtain explicit user confirmation before invocation. This is a behavioral hint to the AI, NOT a server-enforced safeguard. A future revision will add server-side enforcement via MCP elicitation once elicitation support is stable across major MCP clients (Claude Desktop, Cursor, ChatGPT). Until then, the safety posture relies on the tool description and on the MCP client's UI conventions.
- Salla API scope identifiers map directly and consistently to the tool permission requirements described here; the exact scope strings will be confirmed against Salla's developer documentation during implementation.
- A re-installation after uninstall is treated as a fresh `app.store.authorize` event. The new merchant record is created from scratch; install URL revocation identifiers from the previous installation are never reused (see FR-030).
- The MCP server runs on Cloudflare Workers. The rate limiting in FR-031 uses the Cloudflare Workers Rate Limiting binding specifically, which maintains counters in Cloudflare's network without KV writes. Since v1 enforces one active URL per merchant (FR-008), per-install-URL and per-merchant rate limits are equivalent in v1; per-merchant rate limiting (shared across multiple URLs) is a deliberate v2 concern.

## Out of Scope

- No OAuth Authorization Server façade: no `/authorize`, `/token`, `/register`, PKCE flow, Dynamic Client Registration, or `.well-known/oauth-authorization-server` endpoint. This is a deliberate deviation from the MCP authorization specification, documented separately in `/docs/spec-deviations.md`.
- No Server-Sent Events or WebSocket transports; all MCP responses are single-shot JSON over Streamable HTTP.
- No Durable Objects, sessions, or per-connection server state; every request is fully independent.
- No stdio transport binary; a future stdio version is a separate project.
- No long-running tasks, async job queues, or background workflows; every tool call completes within a single HTTP request/response cycle.
- Salla Hydra Custom Mode (callback URL with authorization code exchange) is not supported; only Easy Mode (webhook token delivery) is used.
- No server-side enforcement of tool-call confirmation in v1; see Assumptions for elicitation roadmap.

## Clarifications

### Session 2026-04-29

- Q: Should the MCP server enforce its own rate limiting on tool calls, and if so how? → A: **Per-install-URL rate limiting, 60 req/min default** (Option B, with user-specified detail). Implemented via Cloudflare Workers Rate Limiting binding (not KV) to preserve SC-006 zero-writes guarantee. Rate limit gate runs after auth, before tool dispatch. Applies to MCP tool calls only (webhook and internal endpoints exempt); `whoami` counts. Rationale: Salla's own rate limits protect Salla but not the merchant's quota — a leaked URL or runaway LLM loop would exhaust the merchant's Salla budget. Workers Rate Limiting binding makes this protection free (no KV writes, sub-millisecond). Per-merchant shared rate limiting is deferred to v2. Applied as FR-031, updated SC-006 and Assumptions.
- Q: How many active install URLs can a merchant have simultaneously? → A: **One active URL per merchant** (Option A). Minting a new URL atomically revokes the previous active URL. Applied to FR-008 and InstallURL entity.
- Q: What is the expected availability target for the MCP server? → A: **99.9% monthly uptime** (~43 minutes allowable downtime/month, excluding communicated maintenance windows). Applied as SC-009.
- Q: How far before Salla access token expiry should the system trigger a proactive refresh? → A: **60 minutes** (Option B). Configurable via environment variable. Applied to FR-018.
- Q: Does the InstallURL scope snapshot act as a ceiling on tool access (limiting effective scopes to the intersection of merchant's current Salla scopes and the URL's minted scope set), or is it audit-only with live merchant scopes always winning? → A: **Ceiling (Option B).** Effective tool access = merchant's current Salla scopes ∩ install URL's minted scope set. The minted scope set is embedded in the signed token so no extra storage read is required at request time. Applied to FR-015, FR-016, and the InstallURL entity.