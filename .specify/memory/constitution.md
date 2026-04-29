# Salla MCP Server — Project Constitution

This document defines the non-negotiable principles for the Salla MCP
Server project. Any specification, plan, task, or code that violates
these principles is invalid and must be revised.

## Core principles

### 1. Two-token isolation
The MCP-side credential (the install JWT presented by Claude) and the
upstream Salla credential (the access token used to call the Salla API)
are separate tokens with separate lifecycles. The Worker MUST NOT
forward the install JWT to Salla. Salla tokens MUST NOT appear in any
response to an MCP client. Code that conflates the two is a violation.

### 2. Single credential boundary
Salla access and refresh tokens are accessed exclusively through one
function: `getValidSallaToken(storeId)`. Tool handlers MUST NOT read
KV, decrypt tokens, or call refresh logic directly. This boundary
exists so that the storage backend can change (KV today, broker or
vault tomorrow) without touching tool code.

### 3. Stateless tools
Each MCP request is independent. No session state, no Durable Objects,
no SSE streaming. Per request: verify auth, resolve store, call Salla,
return JSON, end.

### 4. Encryption at rest for upstream credentials
Salla access and refresh tokens MUST be encrypted in KV using AES-GCM.
Plaintext tokens MUST NOT exist outside the in-memory scope of a single
request. Encryption keys live in Worker Secrets, never in KV values
and never in source.

### 5. No secrets in logs
Logs MAY include `store_id`, `jti`, `tool_name`, `status_code`,
`latency_ms`, and similar non-sensitive metadata. Logs MUST NOT include
any token (install JWT, Salla access, Salla refresh), HMAC secret,
client_secret, or merchant PII. The logger MUST scrub these fields by
default.

### 6. Scope enforcement at two layers
`tools/list` filters tools by the JWT's scopes (UX layer). `tools/call`
re-validates the required scopes against the JWT AND against the live
scopes returned by Salla on the most recent token (security layer).
Skipping the second check is a violation.

### 7. Refresh is a critical section
Salla refresh tokens are single-use; parallel refresh attempts will
lock out a merchant. All upstream-token refresh logic MUST go through
a per-store mutex (KV CAS), with a grace window allowing the previous
refresh token to remain valid until the new one is successfully used.

### 8. Webhook signature verification is mandatory
Every request to `/webhooks/salla` MUST have its HMAC signature
verified before any other logic runs. Webhook handlers MUST be
idempotent — replaying the same event MUST be safe.

### 9. Spec deviations are documented
Where this project deviates from the MCP authorization spec
(install URL pattern, query-string token compatibility, no PKCE,
no DCR, no protected-resource-metadata discovery), the deviation
MUST be documented in `/docs/spec-deviations.md` with the reason
and a reverse-migration path.

### 10. Auth code requires tests
Any PR touching authentication, token storage, refresh, webhook
verification, or scope enforcement MUST include unit tests. Tool
handlers MAY ship with integration tests only, but the auth path
MUST have direct unit coverage.

## Stack lock-in

- Runtime: Cloudflare Workers
- Framework: Hono
- MCP SDK: @modelcontextprotocol/sdk (Streamable HTTP, stateless mode)
- Validation: Zod
- Storage: Workers KV (two namespaces: SALLA_TOKENS, JWT_DENYLIST)
- Language: TypeScript (strict mode)
- Salla OAuth: Easy Mode (webhook-driven token delivery)

## Out of scope

The following are explicitly NOT part of this project:

- OAuth Authorization Server façade (PKCE, DCR, /.well-known endpoints)
- SSE or WebSocket transports
- Durable Objects
- Long-running tasks, async jobs, or background workflows
- Stdio binary (separate project, separate repo)
- Multi-tenant isolation beyond per-store_id keying
- Custom Mode OAuth (auth code callback + exchange)

## Amendment process

Changes to this constitution require explicit approval and an updated
`/docs/spec-deviations.md` entry where applicable. Speckit-generated
specs, plans, and tasks MUST conform to the constitution as it exists
when they are generated.