export async function hmacSha256Hex(key: string, body: string | ArrayBuffer): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;

  const signatureBytes = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return bufferToHex(new Uint8Array(signatureBytes));
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Constant-time: run the loop anyway but always return false
    let dummy = 0;
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      dummy |= (a.charCodeAt(i % a.length) ^ b.charCodeAt(i % b.length));
    }
    return dummy === 0 && false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bufferToHex(new Uint8Array(hashBytes));
}

function bufferToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
