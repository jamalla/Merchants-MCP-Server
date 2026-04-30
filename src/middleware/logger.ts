import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types.js";

const ALLOWED_FIELDS = new Set([
  "store_id",
  "jti",
  "tool_name",
  "method",
  "endpoint",
  "webhook_event",
  "outcome",
  "status_code",
  "latency_ms",
  "event",
  "level",
  "ts",
  "request_id",
]);

const TOKEN_PATTERNS = [
  /^(access|refresh)_token/i,
  /secret/i,
  /password/i,
  /signing/i,
  /enc_key/i,
  /client_secret/i,
  /bearer/i,
  /authorization/i,
  /scope/i,
];

type LogLevel = "debug" | "info" | "warn" | "error";

type AllowedLogField =
  | "store_id"
  | "jti"
  | "tool_name"
  | "method"
  | "endpoint"
  | "webhook_event"
  | "outcome"
  | "status_code"
  | "latency_ms"
  | "event"
  | "level"
  | "ts"
  | "request_id";

type LogEntry = Partial<Record<AllowedLogField, string | number>>;

function sanitizeFields(fields: Record<string, unknown>): LogEntry {
  const result: LogEntry = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      continue;
    }
    if (TOKEN_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    const stringValue = String(value);
    if (stringValue.length > 200) {
      continue;
    }
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

function emit(level: LogLevel, fields: LogEntry): void {
  const entry = {
    ts: Date.now(),
    level,
    ...fields,
  };
  console.log(JSON.stringify(entry));
}

export function createLogger(c: Context<{ Bindings: Env }>) {
  const requestId = c.get("requestId") as string | undefined;

  return {
    info(event: string, fields: Record<string, unknown> = {}): void {
      emit("info", sanitizeFields({ event, request_id: requestId, ...fields }));
    },
    warn(event: string, fields: Record<string, unknown> = {}): void {
      emit("warn", sanitizeFields({ event, request_id: requestId, ...fields }));
    },
    error(event: string, fields: Record<string, unknown> = {}): void {
      emit("error", sanitizeFields({ event, request_id: requestId, ...fields }));
    },
    debug(event: string, fields: Record<string, unknown> = {}): void {
      emit("debug", sanitizeFields({ event, request_id: requestId, ...fields }));
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

export const loggerMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const start = Date.now();
  await next();
  const logger = createLogger(c);
  logger.info("request", {
    method: c.req.method,
    endpoint: new URL(c.req.url).pathname,
    status_code: c.res.status,
    latency_ms: Date.now() - start,
  });
};

export { sanitizeFields };
