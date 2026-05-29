/**
 * floodGuard.ts
 *
 * Anti-flood untuk pesan chatroom. Dapat dikonfigurasi dari panel admin
 * (tabel `system_settings`):
 *
 *   chat.flood.enabled       "true" | "false"     (default: true)
 *   chat.flood.maxMessages   integer              (default: 5)
 *   chat.flood.windowMs      integer milliseconds (default: 3000)
 *   chat.flood.action        "warn" | "disconnect" (default: "disconnect")
 *
 * Setting di-cache dan di-refresh otomatis tiap 10 detik. Per-user
 * sliding window menggunakan timestamp di memory (ringan).
 */

import { db } from "./db";
import { sql } from "drizzle-orm";

interface FloodSettings {
  enabled: boolean;
  maxMessages: number;
  windowMs: number;
  action: "warn" | "disconnect";
}

const DEFAULT_SETTINGS: FloodSettings = {
  enabled: true,
  maxMessages: 5,
  windowMs: 3000,
  action: "disconnect",
};

let cached: FloodSettings = { ...DEFAULT_SETTINGS };
let initialized = false;

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS system_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadSettings(): Promise<void> {
  try {
    await ensureTable();
    const r = await db.execute(sql`
      SELECT key, value FROM system_settings WHERE key LIKE 'chat.flood.%'
    `);
    const map = new Map<string, string>();
    for (const row of r.rows as Array<{ key: string; value: string }>) {
      map.set(row.key, row.value);
    }
    const next: FloodSettings = {
      enabled: (map.get("chat.flood.enabled") ?? "true").toLowerCase() === "true",
      maxMessages: clampInt(parseInt(map.get("chat.flood.maxMessages") ?? "", 10), 1, 100, DEFAULT_SETTINGS.maxMessages),
      windowMs: clampInt(parseInt(map.get("chat.flood.windowMs") ?? "", 10), 500, 60_000, DEFAULT_SETTINGS.windowMs),
      action: (map.get("chat.flood.action") === "warn" ? "warn" : "disconnect"),
    };
    cached = next;
  } catch (err) {
    console.warn("[floodGuard] Failed to load settings, using defaults:", err);
  }
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export async function initFloodGuard(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await loadSettings();
  setInterval(() => { loadSettings().catch(() => {}); }, 10_000);
}

export function getFloodSettings(): FloodSettings {
  return { ...cached };
}

// Per-user sliding window timestamps
const userTimestamps = new Map<string, number[]>();

export interface FloodCheckResult {
  allowed: boolean;
  violated: boolean;
  action: "warn" | "disconnect";
  retryAfterMs: number;
  maxMessages: number;
  windowMs: number;
}

/**
 * Catat satu percobaan kirim pesan oleh userId. Return:
 *   - allowed = true  → pesan boleh diproses
 *   - allowed = false → pesan harus ditolak (dan action menentukan apakah
 *                       sekedar warn atau ws di-close)
 */
export function recordMessage(userId: string): FloodCheckResult {
  const cfg = cached;
  if (!cfg.enabled) {
    return { allowed: true, violated: false, action: cfg.action, retryAfterMs: 0, maxMessages: cfg.maxMessages, windowMs: cfg.windowMs };
  }
  const now = Date.now();
  const cutoff = now - cfg.windowMs;
  const arr = userTimestamps.get(userId) ?? [];
  // Drop expired
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  const fresh = i > 0 ? arr.slice(i) : arr;
  if (fresh.length >= cfg.maxMessages) {
    // Violation — DON'T add this attempt to the window so window doesn't keep growing
    userTimestamps.set(userId, fresh);
    const oldest = fresh[0];
    return {
      allowed: false,
      violated: true,
      action: cfg.action,
      retryAfterMs: Math.max(0, oldest + cfg.windowMs - now),
      maxMessages: cfg.maxMessages,
      windowMs: cfg.windowMs,
    };
  }
  fresh.push(now);
  userTimestamps.set(userId, fresh);
  return { allowed: true, violated: false, action: cfg.action, retryAfterMs: 0, maxMessages: cfg.maxMessages, windowMs: cfg.windowMs };
}

export function clearUserFloodState(userId: string): void {
  userTimestamps.delete(userId);
}
