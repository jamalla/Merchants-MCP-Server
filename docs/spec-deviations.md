# MCP Specification Deviations

This document records deliberate deviations from the MCP authorization specification and related standards. Each entry includes the reason for the deviation and a reverse-migration path.

---

## Deviation 1: No OAuth Authorization Server Façade

**What the MCP spec says**: The MCP authorization specification (2025-03-26) requires that servers implementing OAuth 2.1 expose a compliant Authorization Server with endpoints including `/authorize`, `/token`, Dynamic Client Registration (`/register`), PKCE support, and a `.well-known/oauth-authorization-server` discovery document.

**What we do instead**: Authentication is entirely via dashboard-issued install URL JWTs. There is no `/authorize`, `/token`, `/register`, PKCE, DCR, or `.well-known` endpoint. The install URL JWT is a pre-issued Bearer token with a 90-day lifetime, minted by an internal server-to-server endpoint callable only by the Salla Dashboard backend.

**Reason**: The MCP OAuth flow is designed for public clients (browser apps, CLI tools) that need to dynamically register and obtain tokens interactively. Salla merchants are authenticated to the Salla Dashboard, which is a trusted server that can mint tokens on their behalf. Implementing a full OAuth AS would add significant complexity (PKCE, token endpoint, client registry) with no user-facing benefit, since the merchant never interacts directly with the auth flow — they only copy a URL.

**Client impact**: MCP clients that strictly require OAuth discovery will not auto-configure against this server. Merchants must manually paste the install URL. Claude Desktop, Cursor, and compatible clients support manual URL configuration.

**Reverse-migration path**: To add OAuth AS support in the future:
1. Implement `/authorize` (redirect to Salla's OAuth flow), `/token` (exchange code for install JWT), and `/register` (DCR) endpoints
2. Add `.well-known/oauth-authorization-server` discovery pointing to these
3. The install JWT format and MCP endpoint are unchanged — only the token-acquisition path changes
4. Existing install URLs continue to work alongside the new OAuth path

---

## Deviation 2: No SSE or WebSocket Transport

**What the MCP spec says**: The MCP specification defines multiple transports including Server-Sent Events (SSE) for streaming responses and WebSocket for bidirectional communication.

**What we do instead**: All responses are single-shot JSON over Streamable HTTP. Each request returns one complete JSON response. No streaming, no persistent connections.

**Reason**: Cloudflare Workers have a maximum request duration limit. SSE requires a persistent open connection, which is incompatible with the Workers execution model (and contradicts the stateless constraint). All Salla API calls complete within seconds; no tool requires streaming output.

**Reverse-migration path**: To add SSE support, move to Cloudflare Workers with Durable Objects (for connection state) or a different runtime. The tool implementations are decoupled from the transport layer.

---

## Deviation 3: Query Parameter Token Acceptance

**What the MCP spec says**: Bearer tokens should be transmitted in the `Authorization` header per RFC 6750.

**What we do instead**: The MCP endpoint accepts the install URL JWT as either an `Authorization: Bearer` header (preferred) or a `?token=` URL query parameter.

**Reason**: The Salla Dashboard generates a complete install URL including the token as a query parameter (e.g., `https://mcp.salla.dev/v1/mcp?token=eyJ...`). Merchants copy this URL and paste it directly into their MCP client. Some MCP clients (including the initial Dashboard-generated format) embed the token in the URL rather than using a separate header configuration. The query parameter is accepted for this compatibility case only.

**Security note**: Query parameters may appear in server logs. The MCP server's logger explicitly omits token values from all log entries (FR-026). When both header and query parameter are present, the header takes precedence.

**Reverse-migration path**: Remove query parameter acceptance once all major MCP clients support separate URL + Bearer header configuration. FR-011 already documents header as preferred.

---

## Deviation 4: No Protected Resource Metadata Discovery

**What the MCP spec says**: RFC 9728 (OAuth 2.0 Protected Resource Metadata) defines a `.well-known/oauth-protected-resource` discovery document.

**What we do instead**: No discovery document is exposed.

**Reason**: Discovery is only meaningful when clients can dynamically discover how to obtain tokens. Since token acquisition is manual (dashboard URL copy-paste), there is no client to discover or use the metadata.

**Reverse-migration path**: Add `.well-known/oauth-protected-resource` pointing to the Authorization Server once Deviation 1 is resolved.
