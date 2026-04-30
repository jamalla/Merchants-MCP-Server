import { z } from "zod";
import * as sallaClient from "../../lib/salla-client.js";
import { SALLA_SCOPES } from "../../constants.js";
import type { ToolDefinition } from "./registry.js";
import { toolSuccess, toolError } from "./registry.js";

const schema = z.object({
  status: z.string().optional(),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format").optional(),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format").optional(),
  page: z.number().int().min(1).default(1).optional(),
});

export const listOrdersTool: ToolDefinition = {
  name: "list_orders",
  description: "List orders for this store with optional filters.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter by order status" },
      from_date: { type: "string", format: "date", description: "Start date (YYYY-MM-DD)" },
      to_date: { type: "string", format: "date", description: "End date (YYYY-MM-DD)" },
      page: { type: "integer", minimum: 1, default: 1 },
    },
  },
  requiredScopes: [SALLA_SCOPES.ORDERS_READ_WRITE],
  requiresElicitation: false,
  handler: async (rawArgs, ctx) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.errors[0]?.message ?? "invalid input"), {
        code: "INVALID_INPUT",
      });
    }
    const args = parsed.data;
    try {
      const result = await sallaClient.listOrders(ctx.accessToken, {
        ...(args.status !== undefined && { status: args.status }),
        ...(args.from_date !== undefined && { date_from: args.from_date }),
        ...(args.to_date !== undefined && { date_to: args.to_date }),
        ...(args.page !== undefined && { page: args.page }),
      });
      return toolSuccess(JSON.stringify(result));
    } catch (err) {
      if (err instanceof sallaClient.SallaApiError) throw err;
      return toolError("Failed to list orders");
    }
  },
};
