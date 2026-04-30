import type { Env } from "../types.js";

export interface EncryptedField {
  ct: string;
  iv: string;
}

export function currentKeyVersion(env: Env): number {
  const version = parseInt(env.ACTIVE_KEY_VERSION, 10);
  if (isNaN(version) || version < 1) {
    throw new Error("ACTIVE_KEY_VERSION must be a positive integer");
  }
  return version;
}

function getEncKeyForVersion(env: Env, version: number): string {
  const key = (env as unknown as Record<string, unknown>)[`TOKEN_ENC_KEY_V${version}`] as string | undefined;
  if (!key) {
    throw new Error(`TOKEN_ENC_KEY_V${version} is not set`);
  }
  return key;
}

export async function deriveKey(env: Env, storeId: string, version: number): Promise<CryptoKey> {
  const rawKeyB64 = getEncKeyForVersion(env, version);
  const rawKeyBytes = base64ToBytes(rawKeyB64);

  const saltBytes = base64ToBytes(env.ENCRYPTION_SALT);
  const infoBytes = new TextEncoder().encode(`salla-mcp:store:${storeId}`);

  const importedKey = await crypto.subtle.importKey(
    "raw",
    rawKeyBytes,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBytes,
      info: infoBytes,
    },
    importedKey,
    256,
  );

  return crypto.subtle.importKey("raw", derivedBits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptField(
  plaintext: string,
  env: Env,
  storeId: string,
  version: number,
): Promise<EncryptedField> {
  const key = await deriveKey(env, storeId, version);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const ciphertextBytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    plaintextBytes,
  );

  return {
    ct: bytesToBase64(new Uint8Array(ciphertextBytes)),
    iv: bytesToBase64(ivBytes),
  };
}

export async function decryptField(
  ct: string,
  iv: string,
  env: Env,
  storeId: string,
  version: number,
): Promise<string> {
  const key = await deriveKey(env, storeId, version);
  const ivBytes = base64ToBytes(iv);
  const ctBytes = base64ToBytes(ct);

  let plaintextBytes: ArrayBuffer;
  try {
    plaintextBytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, ctBytes);
  } catch {
    throw new Error("decryption failed: ciphertext is tampered or key is wrong");
  }

  return new TextDecoder().decode(plaintextBytes);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
