import { z } from "zod";
import * as sallaClient from "../../lib/salla-client.js";
import { SALLA_SCOPES } from "../../constants.js";
import type { ToolDefinition } from "./registry.js";
import { toolSuccess } from "./registry.js";

const schema = z.object({
  product_ids: z.array(z.string()).optional(),
  sku: z.string().optional(),
});

export const getInventoryLevelsTool: ToolDefinition = {
  name: "get_inventory_levels",
  description: "Get inventory levels for products.",
  inputSchema: {
    type: "object",
    properties: {
      product_ids: {
        type: "array",
        items: { type: "string" },
        description: "List of product IDs to fetch inventory for",
      },
      sku: { type: "string", description: "Filter by SKU" },
    },
  },
  requiredScopes: [SALLA_SCOPES.PRODUCTS_READ_WRITE],
  requiresElicitation: false,
  handler: async (rawArgs, ctx) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.errors[0]?.message ?? "invalid input"), {
        code: "INVALID_INPUT",
      });
    }
    const result = await sallaClient.getInventoryLevels(ctx.accessToken, {
      ...(parsed.data.product_ids !== undefined && { product_ids: parsed.data.product_ids }),
      ...(parsed.data.sku !== undefined && { sku: parsed.data.sku }),
    });
    return toolSuccess(JSON.stringify(result));
  },
};
