# Quickstart: Local Dev & First Tool Call

**Branch**: `001-salla-merchant-mcp`  
**Runtime**: Cloudflare Workers (Wrangler dev server)

---

## Prerequisites

- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)
- A Salla Partner Portal account with a test app configured for Easy Mode

---

## 1. Clone & Install

```bash
git clone <repo-url> salla-mcp-server
cd salla-mcp-server
npm install
```

---

## 2. Configure Local Secrets

Create `.dev.vars` (gitignored) in the repo root:

```ini
# 32-byte key, base64-encoded — generate with: openssl rand -base64 32
ENCRYPTION_KEY=<base64-32-byte-key>

# Arbitrary string for local testing
JWT_SIGNING_SECRET=local-dev-jwt-secret

# Must match what your Salla test app sends in webhook signatures
SALLA_WEBHOOK_SECRET=<from-salla-partner-portal>

# Arbitrary string for local internal API testing
INTERNAL_API_SECRET=local-dev-internal-secret

# From Salla app settings
SALLA_CLIENT_ID=<your-app-client-id>
SALLA_CLIENT_SECRET=<your-app-client-secret>
```

---

## 3. Start the Dev Server

```bash
npx wrangler dev
```

Worker starts at `http://localhost:8787`.

---

## 4. Simulate a Webhook (Token Delivery)

Before minting an install URL, you need a MerchantRecord. Simulate Salla's `app.store.authorize` webhook:

```bash
# Generate a valid HMAC-SHA256 signature for the test body
BODY='{"event":"app.store.authorize","merchant":"test-store-001","data":{"access_token":"test-access-token","refresh_token":"test-refresh-token","expires_in":1209600,"scope":"orders:read products:read"}}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "local-dev-webhook-secret" -hex | cut -d' ' -f2)

curl -X POST http://localhost:8787/webhooks/salla \
  -H "Content-Type: application/json" \
  -H "X-Salla-Signature: $SIG" \
  -d "$BODY"
# Expected: HTTP 200
```

⚠️ Replace `X-Salla-Signature` with the actual Salla header name once confirmed (see `research.md § S1`).

---

## 5. Mint an Install URL

```bash
curl -X POST http://localhost:8787/internal/mint \
  -H "Authorization: Bearer local-dev-internal-secret" \
  -H "Content-Type: application/json" \
  -d '{"store_id":"test-store-001","scopes":["orders:read","products:read"]}'
```

**Response**:
```json
{
  "install_url": "http://localhost:8787/v1/mcp?token=eyJ...",
  "jti": "a1b2c3d4-...",
  "expires_at": 1234567890
}
```

Copy the `install_url` value.

---

## 6. Call a Tool via the MCP Endpoint

Extract the token from the install URL and use it as a Bearer token:

```bash
TOKEN="eyJ..."  # from the install_url above

# initialize
curl -X POST http://localhost:8787/v1/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'

# tools/list
curl -X POST http://localhost:8787/v1/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# whoami (always works regardless of scopes)
curl -X POST http://localhost:8787/v1/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

---

## 7. Connect Claude Desktop

1. Copy the `install_url` from step 5
2. Open Claude Desktop → Settings → Developer → Add MCP Server
3. Paste the URL
4. Claude should now list your available tools

> For production, the URL uses `https://mcp.salla.dev/v1/mcp?token=...`.

---

## 8. Run Tests

```bash
# Unit tests (Workers runtime via vitest-pool-workers)
npm test

# Watch mode
npm run test:watch

# Integration tests (requires wrangler dev running)
npm run test:integration
```

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| HTTP 403 on webhook | Wrong `SALLA_WEBHOOK_SECRET` or wrong header name — check `research.md § S1` |
| HTTP 401 on tool call | JWT expired, revoked, or wrong `JWT_SIGNING_SECRET` — try `whoami` first |
| HTTP 404 on mint | No MerchantRecord for `store_id` — run the webhook simulation first (step 4) |
| HTTP 429 on tool call | Rate limit hit (60 req/min per install URL) — wait 60 seconds |
| `decryption failed` error | `ENCRYPTION_KEY` changed after data was written — clear local KV and re-run webhook |
