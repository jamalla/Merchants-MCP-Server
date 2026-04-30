import { z } from "zod";
import * as sallaClient from "../../lib/salla-client.js";
import { SALLA_SCOPES } from "../../constants.js";
import type { ToolDefinition } from "./registry.js";
import { toolSuccess } from "./registry.js";

const schema = z.object({
  order_id: z.string().min(1),
});

export const getOrderTool: ToolDefinition = {
  name: "get_order",
  description: "Fetch a single order by its ID.",
  inputSchema: {
    type: "object",
    required: ["order_id"],
    properties: {
      order_id: { type: "string", description: "Salla order ID" },
    },
  },
  requiredScopes: [SALLA_SCOPES.ORDERS_READ_WRITE],
  requiresElicitation: false,
  handler: async (rawArgs, ctx) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.errors[0]?.message ?? "order_id is required"), {
        code: "INVALID_INPUT",
      });
    }
    const result = await sallaClient.getOrder(ctx.accessToken, parsed.data.order_id);
    return toolSuccess(JSON.stringify(result));
  },
};
