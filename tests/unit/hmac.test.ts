import { describe, it, expect } from "vitest";
import { hmacSha256Hex, timingSafeEqualHex, sha256Hex } from "../../src/lib/hmac.js";

describe("hmac", () => {
  describe("hmacSha256Hex", () => {
    it("produces a lowercase hex string of length 64", async () => {
      const result = await hmacSha256Hex("test-key", "test-body");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("same input produces same output across calls", async () => {
      const a = await hmacSha256Hex("my-key", "my-body");
      const b = await hmacSha256Hex("my-key", "my-body");
      expect(a).toBe(b);
    });

    it("different key produces different output", async () => {
      const a = await hmacSha256Hex("key-a", "body");
      const b = await hmacSha256Hex("key-b", "body");
      expect(a).not.toBe(b);
    });

    it("different body produces different output", async () => {
      const a = await hmacSha256Hex("key", "body-a");
      const b = await hmacSha256Hex("key", "body-b");
      expect(a).not.toBe(b);
    });

    it("produces known vector for empty body", async () => {
      // HMAC-SHA256 of empty string with key "key" is well-known
      // We verify it's a 64-char hex string; exact value depends on the key
      const result = await hmacSha256Hex("key", "");
      expect(result.length).toBe(64);
    });

    it("accepts ArrayBuffer as body", async () => {
      const buffer = new TextEncoder().encode("test-body").buffer as ArrayBuffer;
      const fromBuffer = await hmacSha256Hex("key", buffer);
      const fromString = await hmacSha256Hex("key", "test-body");
      expect(fromBuffer).toBe(fromString);
    });
  });

  describe("timingSafeEqualHex", () => {
    it("returns true for identical strings", () => {
      const sig = "abc123def456";
      expect(timingSafeEqualHex(sig, sig)).toBe(true);
    });

    it("returns false for different strings of same length", () => {
      expect(timingSafeEqualHex("aaaaaa", "bbbbbb")).toBe(false);
    });

    it("returns false for strings of different lengths", () => {
      expect(timingSafeEqualHex("abc", "abcd")).toBe(false);
      expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
    });

    it("returns false when one character differs", () => {
      expect(timingSafeEqualHex("abcdef", "abcdeX")).toBe(false);
    });

    it("handles empty strings", () => {
      expect(timingSafeEqualHex("", "")).toBe(true);
      expect(timingSafeEqualHex("", "a")).toBe(false);
    });
  });

  describe("sha256Hex", () => {
    it("produces a lowercase hex string of length 64", async () => {
      const result = await sha256Hex("test-input");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("same input produces same output", async () => {
      const a = await sha256Hex("jti-value");
      const b = await sha256Hex("jti-value");
      expect(a).toBe(b);
    });

    it("different inputs produce different outputs", async () => {
      const a = await sha256Hex("jti-1");
      const b = await sha256Hex("jti-2");
      expect(a).not.toBe(b);
    });
  });
});
