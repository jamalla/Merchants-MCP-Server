import { describe, it, expect } from "vitest";
import { scopeIntersection, hasRequiredScopes, parseScopeString } from "../../src/lib/scope.js";

describe("scope", () => {
  describe("scopeIntersection", () => {
    it("returns scopes present in both arrays", () => {
      const jwt = ["orders:read", "products:read", "shipments:read"];
      const live = ["orders:read", "products:read"];
      expect(scopeIntersection(jwt, live)).toEqual(["orders:read", "products:read"]);
    });

    it("returns empty array when no overlap", () => {
      const jwt = ["orders:read"];
      const live = ["products:read"];
      expect(scopeIntersection(jwt, live)).toEqual([]);
    });

    it("returns empty array for empty JWT scopes", () => {
      expect(scopeIntersection([], ["orders:read"])).toEqual([]);
    });

    it("returns empty array for empty live scopes", () => {
      expect(scopeIntersection(["orders:read"], [])).toEqual([]);
    });

    it("enforces ceiling: JWT scope absent from live scopes is excluded", () => {
      const jwt = ["orders:read", "orders:write", "admin:read"];
      const live = ["orders:read", "products:read"];
      expect(scopeIntersection(jwt, live)).toEqual(["orders:read"]);
    });

    it("is case-sensitive (scope strings are exact)", () => {
      expect(scopeIntersection(["Orders:Read"], ["orders:read"])).toEqual([]);
    });
  });

  describe("hasRequiredScopes", () => {
    it("returns true when all required scopes are in effective scopes", () => {
      const effective = ["orders:read", "products:read"];
      expect(hasRequiredScopes(effective, ["orders:read"])).toBe(true);
      expect(hasRequiredScopes(effective, ["orders:read", "products:read"])).toBe(true);
    });

    it("returns false when a required scope is missing", () => {
      const effective = ["orders:read"];
      expect(hasRequiredScopes(effective, ["orders:read", "orders:write"])).toBe(false);
    });

    it("whoami exemption: empty required scopes always returns true", () => {
      expect(hasRequiredScopes([], [])).toBe(true);
      expect(hasRequiredScopes(["orders:read"], [])).toBe(true);
    });
  });

  describe("parseScopeString", () => {
    it("splits space-separated scope strings", () => {
      expect(parseScopeString("orders:read products:read")).toEqual([
        "orders:read",
        "products:read",
      ]);
    });

    it("handles comma-separated scopes", () => {
      expect(parseScopeString("orders:read,products:read")).toEqual([
        "orders:read",
        "products:read",
      ]);
    });

    it("trims whitespace and filters empty entries", () => {
      expect(parseScopeString("  orders:read   products:read  ")).toEqual([
        "orders:read",
        "products:read",
      ]);
    });

    it("returns empty array for empty string", () => {
      expect(parseScopeString("")).toEqual([]);
    });
  });
});
