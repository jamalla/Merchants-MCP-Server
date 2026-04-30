export function scopeIntersection(jwtScopes: string[], liveScopes: string[]): string[] {
  const liveSet = new Set(liveScopes);
  return jwtScopes.filter((s) => liveSet.has(s));
}

export function hasRequiredScopes(effectiveScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0) {
    return true;
  }
  const effectiveSet = new Set(effectiveScopes);
  return requiredScopes.every((s) => effectiveSet.has(s));
}

export function parseScopeString(scopeString: string): string[] {
  return scopeString
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
