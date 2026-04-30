import { z } from "zod";
import * as sallaClient from "../../lib/salla-client.js";
import { SALLA_SCOPES } from "../../constants.js";
import type { ToolDefinition } from "./registry.js";
import { toolSuccess } from "./registry.js";

const schema = z.object({
  query: z.string().optional(),
  category_id: z.string().optional(),
  page: z.number().int().min(1).default(1).optional(),
});

export const searchCatalogTool: ToolDefinition = {
  name: "search_catalog",
  description: "Search the store product catalog.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keyword search" },
      category_id: { type: "string", description: "Filter by category ID" },
      page: { type: "integer", minimum: 1, default: 1 },
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
    const result = await sallaClient.searchCatalog(ctx.accessToken, {
      query: parsed.data.query ?? "",
      ...(parsed.data.page !== undefined && { page: parsed.data.page }),
    });
    return toolSuccess(JSON.stringify(result));
  },
};
