import { decryptField } from "./crypto.js";
import type { Env, MerchantRecord } from "../types.js";

export class RefreshFailedError extends Error {
  constructor(public readonly storeId: string) {
    super(`Salla refresh token is invalidated for store ${storeId}. Merchant must reinstall.`);
    this.name = "RefreshFailedError";
  }
}

export class RefreshInProgressError extends Error {
  constructor() {
    super("Token refresh is in progress; retry shortly.");
    this.name = "RefreshInProgressError";
  }
}

export interface TokenStoreResult {
  accessToken: string;
  scopes: string[];
  record: MerchantRecord;
}

export async function getValidSallaToken(
  storeId: string,
  env: Env,
): Promise<TokenStoreResult | null> {
  const raw = await env.SALLA_TOKENS.get(`store:${storeId}`);
  if (!raw) return null;

  let record: MerchantRecord;
  try {
    record = JSON.parse(raw) as MerchantRecord;
  } catch {
    return null;
  }

  if (record.status === "refresh_failed") {
    throw new RefreshFailedError(storeId);
  }

  // Token refresh logic is added in US5 (T047/T048). For now, signal expired tokens
  // as null so the caller can surface a useful error. The refresh_window check here
  // will be replaced by an actual refresh call in US5.
  if (record.access_expires_at < Date.now()) {
    throw new RefreshFailedError(storeId);
  }

  const accessToken = await decryptField(
    record.access_token_ct,
    record.access_token_iv,
    env,
    storeId,
    record.key_version,
  );

  return { accessToken, scopes: record.scopes, record };
}
