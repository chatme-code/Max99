/**
 * maskSensitive.ts
 *
 * Utility to redact sensitive fields from objects and strings before logging.
 * Covers: password, email, token, pin, credits, balance, and related fields.
 *
 * Usage:
 *   console.log(maskSensitive(requestBody));
 *   console.log(maskSensitiveStr(someMessage));
 */

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordHash",
  "hashedPassword",
  "transfer_pin",
  "transferPin",
  "pin",
  "token",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "jwtToken",
  "apiKey",
  "api_key",
  "email",
  "toEmail",
  "credits",
  "balance",
  "fundedBalance",
  "amount",
  "verifyUrl",
  "verificationUrl",
  "resetToken",
  "secret",
]);

const MASK = "***";

/**
 * Deep-clone an object/array and replace sensitive key values with "***".
 * Non-object values are returned as-is.
 */
export function maskSensitive<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value as T;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return (value as unknown[]).map(maskSensitive) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase()) || SENSITIVE_KEYS.has(k)) {
      result[k] = typeof v === "undefined" ? undefined : MASK;
    } else if (v !== null && typeof v === "object") {
      result[k] = maskSensitive(v);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

/**
 * Mask sensitive patterns inside plain strings.
 * Replaces patterns like:
 *   "password=abc123"  → "password=***"
 *   "token=eyJ..."     → "token=***"
 *   "pin=123456"       → "pin=***"
 *   "email=user@x.com" → "email=***"
 */
const SENSITIVE_PATTERN = new RegExp(
  `\\b(password|token|pin|email|credits|balance|amount|secret|apikey|api_key|verifyurl|transfer_pin)\\s*[=:]\\s*\\S+`,
  "gi"
);

export function maskSensitiveStr(str: string): string {
  return str.replace(SENSITIVE_PATTERN, (_, key: string) => `${key}=***`);
}

/**
 * Safely stringify an object with sensitive fields masked.
 * Safe to pass directly to console.log / logger calls.
 */
export function safeMask(value: unknown): string {
  try {
    return JSON.stringify(maskSensitive(value));
  } catch {
    return String(value);
  }
}
