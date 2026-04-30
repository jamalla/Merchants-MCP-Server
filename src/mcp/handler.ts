import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env, StoreContext } from "../types.js";
import { decryptField } from "../lib/crypto.js";
import { SallaApiError } from "../lib/salla-client.js";
import { hasRequiredScopes } from "../lib/scope.js";
import { createLogger } from "../middleware/logger.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../constants.js";
import { filterToolsByScopes, ALL_TOOLS } from "./tools-list.js";
import type { ToolDefinition } from "./tools/registry.js";

class InsufficientScopeError extends Error {
  constructor(public readonly requiredScopes: string[]) {
    super("Insufficient scope");
    this.name = "InsufficientScopeError";
  }
}

export async function handleMcpRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const logger = createLogger(c);
  const storeCtx = c.get("storeContext");

  // Decrypt access token from KV record — the only place tokens leave encrypted storage
  const record = storeCtx.record;
  let resolvedAccessToken: string;
  try {
    resolvedAccessToken = await decryptField(
      record.access_token_ct,
      record.access_token_iv,
      c.env,
      storeCtx.storeId,
      record.key_version,
    );
  } catch {
    c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
    return c.json({ error: "invalid_token" }, 401);
  }

  // Enrich storeCtx with decrypted token so tool handlers can use it
  const enrichedCtx: StoreContext = { ...storeCtx, accessToken: resolvedAccessToken };

  // Fresh McpServer per request — stateless, no cross-request state (constitution principle 3)
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Register only tools the merchant's scopes permit
  const allowedTools = filterToolsByScopes(storeCtx.effectiveScopes);
  for (const tool of allowedTools) {
    registerTool(server, tool, enrichedCtx, c.env);
  }

  // Stateless transport — omitting sessionIdGenerator enables stateless mode
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    // Pre-intercept: if a tools/call names an out-of-scope tool, return HTTP 403
    // before the MCP SDK can produce a generic error
    const body = await tryParseBody(c.req.raw);
    const rpcParams = body?.params;
    const rpcParamsObj =
      rpcParams !== null && typeof rpcParams === "object"
        ? (rpcParams as Record<string, unknown>)
        : undefined;
    const rpcMethod = body?.method;
    const rpcToolName =
      rpcMethod === "tools/call" && typeof rpcParamsObj?.["name"] === "string"
        ? (rpcParamsObj["name"] as string)
        : undefined;

    if (rpcToolName) {
      const toolInAllowed = allowedTools.find((t) => t.name === rpcToolName);
      if (!toolInAllowed) {
        const globalTool = ALL_TOOLS.find((t) => t.name === rpcToolName);
        if (globalTool && !hasRequiredScopes(storeCtx.effectiveScopes, globalTool.requiredScopes)) {
          const scopeList = globalTool.requiredScopes.join(" ");
          c.header(
            "WWW-Authenticate",
            `Bearer error="insufficient_scope", scope="${scopeList}"`,
          );
          logger.warn("scope_denied", {
            tool_name: rpcToolName,
            store_id: storeCtx.storeId,
            jti: storeCtx.jti,
            event: "scope_denied",
            status_code: 403,
          });
          return c.json({ error: "insufficient_scope", required: globalTool.requiredScopes }, 403);
        }
      }
    }

    const response = await transport.handleRequest(
      body ? buildRequestWithParsedBody(c.req.raw, body) : c.req.raw,
    );

    logger.info("mcp_request", {
      store_id: storeCtx.storeId,
      jti: storeCtx.jti,
      method: typeof rpcMethod === "string" ? rpcMethod : "unknown",
      tool_name: rpcToolName,
      status_code: response.status,
      event: "mcp_request",
    });

    return response;
  } catch (err) {
    if (err instanceof SallaApiError) {
      if (err.statusCode === 429) {
        const res = c.json({ error: "upstream_rate_limited" }, 429);
        if (err.retryAfter) c.header("Retry-After", err.retryAfter);
        return res;
      }
      return c.json(
        { error: "upstream_error", detail: `Salla API returned ${err.statusCode}` },
        502,
      );
    }
    logger.error("mcp_handler_error", { event: "mcp_handler_error", status_code: 500 });
    return c.json({ error: "internal_error" }, 500);
  } finally {
    await server.close();
  }
}

function registerTool(
  server: McpServer,
  tool: ToolDefinition,
  ctx: StoreContext,
  env: Env,
): void {
  const zodShape = buildZodShape(tool);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool(tool.name, tool.description, zodShape, async (args): Promise<any> => {
    // Re-validate scope at call time (defense-in-depth, constitution principle 6)
    if (!hasRequiredScopes(ctx.effectiveScopes, tool.requiredScopes)) {
      throw new InsufficientScopeError(tool.requiredScopes);
    }
    return await tool.handler(args as Record<string, unknown>, ctx, env);
  });
}

function buildZodShape(tool: ToolDefinition): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const props = tool.inputSchema.properties;
  const required = new Set(tool.inputSchema.required ?? []);

  for (const [key, schemaDef] of Object.entries(props)) {
    const def = schemaDef as Record<string, unknown>;
    let field: z.ZodTypeAny;

    if (def.type === "string") {
      field =
        def.format === "date" ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/) : z.string();
    } else if (def.type === "integer") {
      field = z.number().int();
      if (typeof def.minimum === "number") field = (field as z.ZodNumber).min(def.minimum);
    } else if (def.type === "array") {
      field = z.array(z.string());
    } else {
      field = z.unknown();
    }

    if (!required.has(key)) {
      field = field.optional() as z.ZodTypeAny;
    }
    shape[key] = field;
  }

  return shape;
}

async function tryParseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const cloned = request.clone();
    const text = await cloned.text();
    if (!text) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildRequestWithParsedBody(original: Request, body: unknown): Request {
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: JSON.stringify(body),
  });
}
