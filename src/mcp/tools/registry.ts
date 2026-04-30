import type { StoreContext, Env } from "../../types.js";

export interface ToolInputSchema {
  type: "object";
  required?: string[];
  properties: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  requiredScopes: string[];
  requiresElicitation?: boolean; // reserved for v2 — never enforced in v1
  handler: (args: Record<string, unknown>, ctx: StoreContext, env: Env) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export function toolSuccess(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
