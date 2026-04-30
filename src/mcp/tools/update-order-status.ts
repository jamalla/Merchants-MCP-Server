import { z } from "zod";
import * as sallaClient from "../../lib/salla-client.js";
import { SALLA_SCOPES } from "../../constants.js";
import type { ToolDefinition } from "./registry.js";
import { toolSuccess } from "./registry.js";

const schema = z.object({
  order_id: z.string().min(1),
  status: z.string().min(1),
});

export const updateOrderStatusTool: ToolDefinition = {
  name: "update_order_status",
  description: "Update the status of an order.",
  inputSchema: {
    type: "object",
    required: ["order_id", "status"],
    properties: {
      order_id: { type: "string", description: "Salla order ID" },
      status: {
        type: "string",
        description:
          "New order status. IMPORTANT: This action modifies a live order. The MCP client SHOULD obtain explicit confirmation from the merchant before invoking this tool. The server does not enforce confirmation in v1; future versions will use MCP elicitation.",
      },
    },
  },
  requiredScopes: [SALLA_SCOPES.ORDERS_READ_WRITE],
  requiresElicitation: false,
  handler: async (rawArgs, ctx) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.errors[0]?.message ?? "order_id and status are required"), {
        code: "INVALID_INPUT",
      });
    }
    const result = await sallaClient.updateOrderStatus(ctx.accessToken, parsed.data.order_id, {
      status: parsed.data.status,
    });
    return toolSuccess(JSON.stringify(result));
  },
};
