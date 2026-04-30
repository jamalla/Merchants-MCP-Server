import type { Env, InstallURLTokenPayload } from "../types.js";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlDecode(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importSigningKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signJWT(
  payload: Omit<InstallURLTokenPayload, "iss" | "aud"> & Partial<Pick<InstallURLTokenPayload, "iss" | "aud">>,
  env: Env,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload: InstallURLTokenPayload = {
    iss: "salla-mcp",
    aud: "salla-mcp",
    ...payload,
  } as InstallURLTokenPayload;

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importSigningKey(env.JWT_SIGNING_SECRET, "sign");
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );

  const signatureB64 = base64UrlEncode(new Uint8Array(signatureBytes));
  return `${signingInput}.${signatureB64}`;
}

export class JWTVerificationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "malformed"
      | "expired"
      | "invalid_signature"
      | "invalid_claims"
      | "missing_jti",
  ) {
    super(message);
    this.name = "JWTVerificationError";
  }
}

export async function verifyJWT(token: string, env: Env): Promise<InstallURLTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JWTVerificationError("malformed JWT: expected 3 parts", "malformed");
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const signingInput = `${headerB64}.${payloadB64}`;

  let payload: InstallURLTokenPayload;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(payloadJson) as InstallURLTokenPayload;
  } catch {
    throw new JWTVerificationError("malformed JWT: payload is not valid JSON", "malformed");
  }

  const key = await importSigningKey(env.JWT_SIGNING_SECRET, "verify");
  const signatureBytes = base64UrlDecode(signatureB64);

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(signingInput),
  );

  if (!valid) {
    throw new JWTVerificationError("invalid JWT signature", "invalid_signature");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSec) {
    throw new JWTVerificationError("JWT has expired", "expired");
  }

  if (payload.iss !== "salla-mcp" || payload.aud !== "salla-mcp") {
    throw new JWTVerificationError("invalid JWT iss or aud", "invalid_claims");
  }

  if (!payload.jti) {
    throw new JWTVerificationError("JWT missing jti claim", "missing_jti");
  }

  return payload;
}
