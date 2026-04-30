export interface Env {
  // KV Namespaces
  SALLA_TOKENS: KVNamespace;
  JWT_DENYLIST: KVNamespace;

  // Rate Limiting
  RATE_LIMITER: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };

  // Encryption — versioned keys (V1, V2, ...)
  TOKEN_ENC_KEY_V1: string;
  TOKEN_ENC_KEY_V2?: string;

  // HKDF salt (base64-encoded)
  ENCRYPTION_SALT: string;

  // Active encryption key version (integer as string, e.g. "1")
  ACTIVE_KEY_VERSION: string;

  // JWT signing
  JWT_SIGNING_SECRET: string;

  // Webhook signature verification — versioned
  SALLA_WEBHOOK_SECRET_V1: string;
  SALLA_WEBHOOK_SECRET_V2?: string;

  // Internal API authentication — versioned
  INTERNAL_API_SECRET_V1: string;
  INTERNAL_API_SECRET_V2?: string;

  // Salla OAuth app credentials
  SALLA_CLIENT_ID: string;
  SALLA_CLIENT_SECRET: string;

  // Runtime configuration
  MCP_ISSUER: string;
  MCP_AUDIENCE: string;
  REFRESH_WINDOW_SECONDS: string;
  MAX_INSTALL_URL_LIFETIME_SECONDS: string;
}

export interface MerchantRecord {
  // Identity (plaintext)
  store_id: string;
  merchant_id?: string;

  // Granted permissions (plaintext)
  scopes: string[];

  // Encrypted credentials (AES-256-GCM with HKDF-derived per-store key)
  access_token_ct: string;
  access_token_iv: string;
  refresh_token_ct: string;
  refresh_token_iv: string;

  // One-cycle prior refresh token retained for KV write failure recovery
  previous_refresh_token_ct?: string;
  previous_refresh_token_iv?: string;

  // Token metadata (plaintext)
  access_expires_at: number;
  refresh_expires_at: number;

  // Install URL state (plaintext)
  active_jti: string | null;

  // Bookkeeping (plaintext)
  installed_at: number;
  updated_at: number;
  last_refreshed_at?: number;
  last_used_at?: number;

  // Key rotation
  key_version: number;

  // Lifecycle
  status: "active" | "refresh_failed";
  schema_version: 1;
}

export interface InstallURLTokenPayload {
  iss: "salla-mcp";
  aud: "salla-mcp";
  sub: string;
  store_id: string;
  jti: string;
  iat: number;
  exp: number;
  scope: string[];
  kid?: string;
}

export interface RevokedJTI {
  revoked_at: number;
  reason: "regenerated" | "manual" | "compromised" | "uninstalled";
  store_id: string;
}

export interface StoreContext {
  storeId: string;
  jti: string;
  effectiveScopes: string[];
  record: MerchantRecord;
  accessToken: string;
}

export interface RefreshLock {
  acquired_at: number;
}
