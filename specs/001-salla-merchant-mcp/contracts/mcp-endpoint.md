# Contract: MCP Endpoint

**Endpoint**: `POST /v1/mcp` (primary), `GET /v1/mcp` (initialize compat)
**Transport**: MCP Streamable HTTP — stateless mode
**Protocol**: Model Context Protocol (MCP) 1.x

---

## Authentication

Every request to `/v1/mcp` must supply a signed install URL JWT.

**Preferred** (header):
```
Authorization: Bearer <install-url-jwt>
```

**Compatibility** (query parameter — for dashboard URL paste format, FR-011):
```
GET /v1/mcp?token=<install-url-jwt>
```

When both are present, the header value is used and the query parameter is ignored. If both are non-empty and differ, a WARN-level log entry is emitted recording only the JTI from the header value (no token contents).

### Token Validation Steps (in order)

1. Parse and verify HS256 signature using `JWT_SIGNING_SECRET` (and `kid` if present, for key rotation). Reject → HTTP 401.
2. Check `exp` claim — not expired. Reject → HTTP 401.
3. Check `iss === "salla-mcp"` and `aud === "salla-mcp"`. Reject → HTTP 401.
4. Compute `sha256(jti)` and check `JWT_DENYLIST.get('jti:' + sha256Hex)`. Must be absent. Reject → HTTP 401.
5. Read `SALLA_TOKENS.get('store:' + sub)`. Must exist. Decrypt sensitive fields. Reject → HTTP 401.
6. Verify `MerchantRecord.status === 'active'`. If `'refresh_failed'` → HTTP 401 with re-install message (FR-021).
7. Compute `effectiveScopes = jwtPayload.scope ∩ merchantRecord.scopes`.
8. Check rate limit — `RATE_LIMITER.limit({ key: jti })`. Reject → HTTP 429 (FR-028 covers Salla 429s separately).

**HTTP 401 response (invalid token)**:
```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token"
Content-Type: application/json

{ "error": "invalid_token" }
```

**HTTP 401 response (refresh_failed — merchant must reinstall)**:
```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="Reinstall the Salla MCP app to restore connectivity"
Content-Type: application/json

{
  "error": "reinstall_required",
  "detail": "The Salla refresh token has been invalidated. Please reinstall the Salla MCP app from the Salla App Store."
}
```

**HTTP 429 response (Worker-level rate limit)**:
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{ "error": "rate_limit_exceeded" }
```

---

## MCP Methods

### `initialize`

**Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "claude-desktop", "version": "1.0" }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "salla-mcp", "version": "1.0.0" }
  }
}
```

The server does NOT advertise `prompts`, `resources`, `sampling`, or other capabilities in v1. Future revisions may add capabilities additively.

---

### `tools/list`

Returns only tools whose required scopes are a subset of `effectiveScopes`. `whoami` is always returned regardless of scope set (FR-015 exemption).

**Request**:
```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

**Response** (example — merchant has `orders:read` only):
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "list_orders",
        "description": "List orders for this store with optional filters.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "status": { "type": "string", "description": "Filter by order status" },
            "from_date": { "type": "string", "format": "date", "description": "Start date (YYYY-MM-DD)" },
            "to_date": { "type": "string", "format": "date", "description": "End date (YYYY-MM-DD)" },
            "page": { "type": "integer", "minimum": 1, "default": 1 }
          }
        }
      },
      {
        "name": "get_order",
        "description": "Fetch a single order by its ID.",
        "inputSchema": {
          "type": "object",
          "required": ["order_id"],
          "properties": {
            "order_id": { "type": "string", "description": "Salla order ID" }
          }
        }
      },
      {
        "name": "whoami",
        "description": "Diagnostic tool. Returns the current store identifier, install URL revocation identifier, and effective scopes. Use this to verify your connection.",
        "inputSchema": { "type": "object", "properties": {} }
      }
    ]
  }
}
```

---

### `tools/call`

Scopes are re-validated server-side on every call regardless of `tools/list` output (constitution principle 6).

**Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "list_orders",
    "arguments": { "status": "pending", "page": 1 }
  }
}
```

**Success response**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"orders\": [...], \"pagination\": {...}}"
      }
    ],
    "isError": false
  }
}
```

**Scope error (HTTP 403, FR-023)**:
```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", scope="orders:write"
Content-Type: application/json

{ "error": "insufficient_scope", "required": ["orders:write"] }
```

**Schema validation error (HTTP 400, FR-017)**:
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{ "error": "invalid_input", "detail": "order_id is required" }
```

The `detail` field MUST NOT contain merchant data, tokens, or internal state — only sanitized schema-validation messages.

**Salla API error 5xx (HTTP 502, FR-024)**:
```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json

{ "error": "upstream_error", "detail": "Salla API returned 500" }
```

If the upstream Salla response includes a `Retry-After` header, it is forwarded.

**Salla API rate limit (HTTP 429, FR-028)**:
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
Content-Type: application/json

{ "error": "upstream_rate_limited" }
```

`Retry-After` is forwarded from Salla's response when present. The Worker does NOT silently retry — the MCP client decides whether and when to retry.

**Refresh in progress, lock contention exhausted (HTTP 502)**:
```http
HTTP/1.1 502 Bad Gateway
Retry-After: 2
Content-Type: application/json

{ "error": "refresh_in_progress", "detail": "Token refresh in progress; retry shortly." }
```

---

## Tool Schemas (complete)

### `list_orders`

```json
{
  "type": "object",
  "properties": {
    "status": { "type": "string" },
    "from_date": { "type": "string", "format": "date" },
    "to_date": { "type": "string", "format": "date" },
    "page": { "type": "integer", "minimum": 1, "default": 1 }
  }
}
```
Required scopes: `orders:read`

### `get_order`

```json
{
  "type": "object",
  "required": ["order_id"],
  "properties": {
    "order_id": { "type": "string" }
  }
}
```
Required scopes: `orders:read`

### `update_order_status`

```json
{
  "type": "object",
  "required": ["order_id", "status"],
  "properties": {
    "order_id": { "type": "string" },
    "status": {
      "type": "string",
      "description": "New order status. IMPORTANT: This action modifies a live order. The MCP client SHOULD obtain explicit confirmation from the merchant before invoking this tool. The server does not enforce confirmation in v1; future versions will use MCP elicitation."
    }
  }
}
```
Required scopes: `orders:write`

### `search_catalog`

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Keyword search" },
    "category_id": { "type": "string" },
    "page": { "type": "integer", "minimum": 1, "default": 1 }
  }
}
```
Required scopes: `products:read`

### `get_inventory_levels`

```json
{
  "type": "object",
  "properties": {
    "product_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of product IDs to fetch inventory for"
    },
    "sku": { "type": "string", "description": "Filter by SKU" }
  }
}
```
Required scopes: `products:read` *(confirm against Salla scope picker — may be `inventory:read`)*

### `get_shipment_tracking`

```json
{
  "type": "object",
  "required": ["order_id"],
  "properties": {
    "order_id": { "type": "string" },
    "shipment_id": { "type": "string", "description": "Optional — if omitted, returns all shipments for the order" }
  }
}
```
Required scopes: `shipments:read` *(confirm exact scope string against Salla scope picker)*

### `whoami`

```json
{ "type": "object", "properties": {} }
```
Required scopes: *(none — always available, FR-015 exemption)*

**Response** (example):
```json
{
  "content": [
    {
      "type": "text",
      "text": "Connected as store 12345. Install URL ID: abc-def-ghi. Effective scopes: orders:read."
    },
    {
      "type": "text",
      "text": "{\"store_id\":\"12345\",\"jti\":\"abc-def-ghi\",\"effective_scopes\":[\"orders:read\"]}"
    }
  ],
  "isError": false
}
```

The first content block is human-readable for AI consumption; the second is a JSON-stringified payload for programmatic use. Both contain only diagnostic identity metadata — no tokens, no PII, no Salla credentials.

---

## Logging Contract

For every request to `/v1/mcp`, the Worker emits exactly one structured log entry on completion:

```json
{
  "ts": 1761779423521,
  "level": "info",
  "event": "mcp_request",
  "store_id": "12345",
  "jti": "abc-def-ghi",
  "method": "tools/call",
  "tool_name": "list_orders",
  "status_code": 200,
  "latency_ms": 142,
  "request_id": "..."
}
```

Allowed fields per constitution principle 5: `store_id`, `jti`, `tool_name`, `status_code`, `latency_ms`, `method`, `event`, `level`, `ts`, `request_id`. Anything else is rejected by the structured logger by default.

Forbidden in any log entry: install URL JWTs, Salla access tokens, Salla refresh tokens, signing secrets, client secrets, webhook secrets, merchant PII (email, phone, billing), tool argument values (which may contain order IDs but also potentially customer data — names not whitelisted).

---

## Error Code Summary

| Status | Error code | Trigger | Source |
|--------|------------|---------|--------|
| 400 | `invalid_input` | Tool args fail Zod schema | FR-017 |
| 401 | `invalid_token` | JWT signature, exp, denylist, or merchant record check fails | FR-022 |
| 401 | `reinstall_required` | Merchant record `status: 'refresh_failed'` | FR-021 |
| 403 | `insufficient_scope` | Tool's required scopes ⊄ effectiveScopes | FR-023 |
| 429 | `rate_limit_exceeded` | Worker rate limiter triggered | spec clarification 5 |
| 429 | `upstream_rate_limited` | Salla API returned 429 | FR-028 |
| 502 | `upstream_error` | Salla API returned 5xx | FR-024 |
| 502 | `refresh_in_progress` | Refresh lock held longer than wait window | plan §4 wait path |

All error responses include `Content-Type: application/json` and a JSON body with at least `error` and (where useful) `detail`. Where a `WWW-Authenticate` header applies it follows RFC 6750 conventions.
