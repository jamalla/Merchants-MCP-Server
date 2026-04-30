// Salla API client — wraps the 6 tool endpoints.
// Base URL and endpoint paths are best-effort from public docs (T006e).
// 🟡 Confirm endpoint paths against https://docs.salla.dev/426392m0 before production.

export const SALLA_API_BASE = "https://api.salla.dev/admin/v2";

export class SallaApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "SallaApiError";
  }
}

export interface SallaListOrdersParams {
  page?: number;
  per_page?: number;
  status?: string;
  date_from?: string;
  date_to?: string;
}

export interface SallaUpdateOrderStatusParams {
  status: string;
}

export interface SallaSearchCatalogParams {
  query: string;
  page?: number;
  per_page?: number;
}

export interface SallaGetInventoryParams {
  product_ids?: string[];
  sku?: string;
}

export interface SallaGetShipmentParams {
  order_id: string;
  shipment_id?: string;
}

async function sallaFetch(
  path: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = `${SALLA_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401) {
    // Signal caller to trigger token refresh path
    throw new SallaApiError(401, "token_expired", "Salla token expired or invalid");
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") ?? undefined;
    throw new SallaApiError(
      429,
      "upstream_rate_limited",
      "Salla API rate limit exceeded",
      retryAfter,
    );
  }

  if (res.status >= 500) {
    throw new SallaApiError(res.status, "upstream_error", `Salla API server error: ${res.status}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new SallaApiError(res.status, "upstream_error", `Salla API error ${res.status}: ${body}`);
  }

  return res.json();
}

export async function listOrders(
  accessToken: string,
  params: SallaListOrdersParams = {},
): Promise<unknown> {
  const query = new URLSearchParams();
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.per_page !== undefined) query.set("per_page", String(params.per_page));
  if (params.status) query.set("status", params.status);
  if (params.date_from) query.set("date_from", params.date_from);
  if (params.date_to) query.set("date_to", params.date_to);

  const qs = query.toString();
  return sallaFetch(`/orders${qs ? `?${qs}` : ""}`, accessToken);
}

export async function getOrder(accessToken: string, orderId: string): Promise<unknown> {
  return sallaFetch(`/orders/${encodeURIComponent(orderId)}`, accessToken);
}

export async function updateOrderStatus(
  accessToken: string,
  orderId: string,
  params: SallaUpdateOrderStatusParams,
): Promise<unknown> {
  return sallaFetch(`/orders/${encodeURIComponent(orderId)}/status`, accessToken, {
    method: "PUT",
    body: JSON.stringify(params),
  });
}

export async function searchCatalog(
  accessToken: string,
  params: SallaSearchCatalogParams,
): Promise<unknown> {
  const query = new URLSearchParams({ q: params.query });
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.per_page !== undefined) query.set("per_page", String(params.per_page));

  return sallaFetch(`/products?${query.toString()}`, accessToken);
}

export async function getInventoryLevels(
  accessToken: string,
  params: SallaGetInventoryParams,
): Promise<unknown> {
  // 🟡 Confirm path and query param names against https://docs.salla.dev/426392m0
  const query = new URLSearchParams();
  if (params.product_ids?.length) query.set("product_ids", params.product_ids.join(","));
  if (params.sku) query.set("sku", params.sku);
  const qs = query.toString();
  return sallaFetch(`/products/availability${qs ? `?${qs}` : ""}`, accessToken);
}

export async function getShipmentTracking(
  accessToken: string,
  params: SallaGetShipmentParams,
): Promise<unknown> {
  // 🟡 Confirm path: may be /shipments/{id} or /orders/{id}/shipments
  if (params.shipment_id) {
    return sallaFetch(`/shipments/${encodeURIComponent(params.shipment_id)}`, accessToken);
  }
  return sallaFetch(`/orders/${encodeURIComponent(params.order_id)}/shipments`, accessToken);
}
