import { hasRequiredScopes } from "../lib/scope.js";
import type { ToolDefinition } from "./tools/registry.js";
import { whoamiTool } from "./tools/whoami.js";
import { listOrdersTool } from "./tools/list-orders.js";
import { getOrderTool } from "./tools/get-order.js";
import { updateOrderStatusTool } from "./tools/update-order-status.js";
import { searchCatalogTool } from "./tools/search-catalog.js";
import { getInventoryLevelsTool } from "./tools/get-inventory-levels.js";
import { getShipmentTrackingTool } from "./tools/get-shipment-tracking.js";

export const ALL_TOOLS: ToolDefinition[] = [
  whoamiTool,
  listOrdersTool,
  getOrderTool,
  updateOrderStatusTool,
  searchCatalogTool,
  getInventoryLevelsTool,
  getShipmentTrackingTool,
];

export function filterToolsByScopes(effectiveScopes: string[]): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => {
    // whoami and tools with no required scopes are always available (FR-015 exemption)
    if (tool.requiredScopes.length === 0) return true;
    return hasRequiredScopes(effectiveScopes, tool.requiredScopes);
  });
}

export function getToolByName(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export function formatToolsListResponse(tools: ToolDefinition[]): unknown {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}
