import { z } from "zod";
import * as sallaClient from "../../lib/salla-client.js";
import { SALLA_SCOPES } from "../../constants.js";
import type { ToolDefinition } from "./registry.js";
import { toolSuccess } from "./registry.js";

const schema = z.object({
  order_id: z.string().min(1),
  shipment_id: z.string().optional(),
});

export const getShipmentTrackingTool: ToolDefinition = {
  name: "get_shipment_tracking",
  description: "Get shipment tracking information for an order.",
  inputSchema: {
    type: "object",
    required: ["order_id"],
    properties: {
      order_id: { type: "string", description: "Salla order ID" },
      shipment_id: {
        type: "string",
        description: "Optional — if omitted, returns all shipments for the order",
      },
    },
  },
  requiredScopes: [SALLA_SCOPES.SHIPMENTS_READ],
  requiresElicitation: false,
  handler: async (rawArgs, ctx) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      throw Object.assign(new Error(parsed.error.errors[0]?.message ?? "order_id is required"), {
        code: "INVALID_INPUT",
      });
    }
    const result = await sallaClient.getShipmentTracking(ctx.accessToken, {
      order_id: parsed.data.order_id,
      ...(parsed.data.shipment_id !== undefined && { shipment_id: parsed.data.shipment_id }),
    });
    return toolSuccess(JSON.stringify(result));
  },
};
