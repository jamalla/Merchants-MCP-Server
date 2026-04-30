// 🟡 Scope strings are best-effort from T006d research.
// Confirm exact strings against the Salla Partner Portal scope picker before production.
// Salla uses dot-notation (e.g. "orders.read_write") — update this file once confirmed.

export const SALLA_SCOPES = {
  ORDERS_READ_WRITE: "orders.read_write",
  PRODUCTS_READ_WRITE: "products.read_write",
  SHIPMENTS_READ: "shipments.read",
} as const;

export type SallaScope = (typeof SALLA_SCOPES)[keyof typeof SALLA_SCOPES];

export const TOOL_SCOPE_MAP: Record<string, string[]> = {
  whoami: [],
  list_orders: [SALLA_SCOPES.ORDERS_READ_WRITE],
  get_order: [SALLA_SCOPES.ORDERS_READ_WRITE],
  update_order_status: [SALLA_SCOPES.ORDERS_READ_WRITE],
  search_catalog: [SALLA_SCOPES.PRODUCTS_READ_WRITE],
  get_inventory_levels: [SALLA_SCOPES.PRODUCTS_READ_WRITE],
  get_shipment_tracking: [SALLA_SCOPES.SHIPMENTS_READ],
};

export const TOOL_NAMES = Object.keys(TOOL_SCOPE_MAP) as Array<keyof typeof TOOL_SCOPE_MAP>;

export const DEFAULT_INSTALL_URL_LIFETIME_SECONDS = 7776000;
export const MAX_INSTALL_URL_LIFETIME_SECONDS = 7776000;

export const REFRESH_LOCK_TTL_SECONDS = 30;
export const REFRESH_LOCK_RETRY_COUNT = 5;
export const REFRESH_LOCK_RETRY_DELAY_MS = 200;

export const DEFAULT_REFRESH_WINDOW_SECONDS = 3600;

export const MCP_SERVER_NAME = "Salla Merchant MCP Server";
export const MCP_SERVER_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "2024-11-05";
