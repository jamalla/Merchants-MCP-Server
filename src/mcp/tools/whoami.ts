import type { ToolDefinition } from "./registry.js";
import { toolSuccess } from "./registry.js";

export const whoamiTool: ToolDefinition = {
  name: "whoami",
  description:
    "Diagnostic tool. Returns the current store identifier, install URL revocation identifier, and effective scopes. Use this to verify your connection.",
  inputSchema: { type: "object", properties: {} },
  requiredScopes: [],
  requiresElicitation: false,
  handler: async (_args, ctx) => {
    const human = `Connected as store ${ctx.storeId}. Install URL ID: ${ctx.jti}. Effective scopes: ${ctx.effectiveScopes.join(", ") || "(none)"}.`;
    const structured = JSON.stringify({
      store_id: ctx.storeId,
      jti: ctx.jti,
      effective_scopes: ctx.effectiveScopes,
    });
    return {
      content: [
        { type: "text" as const, text: human },
        { type: "text" as const, text: structured },
      ],
      isError: false,
    };
  },
};
