import { describe, it, expect } from "vitest";
import { encryptField, decryptField, currentKeyVersion } from "../../src/lib/crypto.js";
import type { Env } from "../../src/types.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SALLA_TOKENS: {} as KVNamespace,
    JWT_DENYLIST: {} as KVNamespace,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    TOKEN_ENC_KEY_V1: "dGVzdC1lbmMta2V5LTMyLWJ5dGVzLXBhZGRlZA==",
    TOKEN_ENC_KEY_V2: "dGVzdC1lbmMta2V5LXYyLTMyLWJ5dGVzLXBhZA==",
    ENCRYPTION_SALT: "dGVzdC1zYWx0LTE2LWJ5dGVz",
    ACTIVE_KEY_VERSION: "1",
    JWT_SIGNING_SECRET: "test-jwt-secret",
    SALLA_WEBHOOK_SECRET_V1: "test-webhook-secret",
    INTERNAL_API_SECRET_V1: "test-internal-secret",
    SALLA_CLIENT_ID: "test-client-id",
    SALLA_CLIENT_SECRET: "test-client-secret",
    MCP_ISSUER: "https://mcp.salla.dev",
    MCP_AUDIENCE: "salla-merchant-mcp",
    REFRESH_WINDOW_SECONDS: "3600",
    MAX_INSTALL_URL_LIFETIME_SECONDS: "7776000",
    ...overrides,
  };
}

describe("crypto", () => {
  describe("currentKeyVersion", () => {
    it("parses ACTIVE_KEY_VERSION as integer", () => {
      expect(currentKeyVersion(makeEnv({ ACTIVE_KEY_VERSION: "1" }))).toBe(1);
      expect(currentKeyVersion(makeEnv({ ACTIVE_KEY_VERSION: "2" }))).toBe(2);
    });

    it("throws on non-integer ACTIVE_KEY_VERSION", () => {
      expect(() => currentKeyVersion(makeEnv({ ACTIVE_KEY_VERSION: "abc" }))).toThrow();
    });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("decrypts to original plaintext for the same store", async () => {
      const env = makeEnv();
      const storeId = "store-abc";
      const plaintext = "super-secret-access-token";

      const { ct, iv } = await encryptField(plaintext, env, storeId, 1);
      const decrypted = await decryptField(ct, iv, env, storeId, 1);

      expect(decrypted).toBe(plaintext);
    });

    it("fails to decrypt with a different storeId (per-store key derivation)", async () => {
      const env = makeEnv();
      const { ct, iv } = await encryptField("secret", env, "store-a", 1);

      await expect(decryptField(ct, iv, env, "store-b", 1)).rejects.toThrow("decryption failed");
    });

    it("detects tampered ciphertext", async () => {
      const env = makeEnv();
      const { ct, iv } = await encryptField("secret", env, "store-x", 1);

      const tamperedCt = ct.slice(0, -4) + "XXXX";
      await expect(decryptField(tamperedCt, iv, env, "store-x", 1)).rejects.toThrow(
        "decryption failed",
      );
    });

    it("fails to decrypt with wrong key version", async () => {
      const env = makeEnv();
      const { ct, iv } = await encryptField("secret", env, "store-y", 1);

      await expect(decryptField(ct, iv, env, "store-y", 2)).rejects.toThrow("decryption failed");
    });

    it("produces different ciphertexts for same plaintext (random IV)", async () => {
      const env = makeEnv();
      const { ct: ct1 } = await encryptField("same-value", env, "store-z", 1);
      const { ct: ct2 } = await encryptField("same-value", env, "store-z", 1);

      expect(ct1).not.toBe(ct2);
    });
  });

  describe("key rotation compatibility", () => {
    it("record encrypted with V1 can be decrypted using V1 even when ACTIVE_KEY_VERSION=2", async () => {
      const env = makeEnv({ ACTIVE_KEY_VERSION: "2" });
      const plaintext = "rotation-test-token";

      // Encrypt with V1 explicitly (simulating a record written before rotation)
      const { ct, iv } = await encryptField(plaintext, env, "store-rotation", 1);

      // Decrypt using V1 explicitly (the key_version field from the stored record)
      const decrypted = await decryptField(ct, iv, env, "store-rotation", 1);
      expect(decrypted).toBe(plaintext);
    });

    it("throws if a version's key is not set", async () => {
      // Build an env that simply lacks TOKEN_ENC_KEY_V2 (exactOptionalPropertyTypes: can't set to undefined)
      const base = makeEnv();
      const env = { ...base } as typeof base & { TOKEN_ENC_KEY_V2?: string };
      delete env.TOKEN_ENC_KEY_V2;
      await expect(encryptField("secret", env, "store-missing", 2)).rejects.toThrow(
        "TOKEN_ENC_KEY_V2 is not set",
      );
    });
  });
});
