/**
 * xpConfig.ts
 *
 * Runtime-mutable XP configuration backed by the `system_settings` table.
 * Each value can be overridden live via the admin UI (PUT /api/xp), with
 * fall-back to compiled-in defaults when the row is missing.
 *
 * Cache TTL: 15 s. Calls to `invalidateXpConfigCache()` (e.g. after admin
 * writes) force the next read to re-fetch immediately so changes take
 * effect right away.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

export interface XpConfig {
  // Per-action XP awards
  chatRoomMessage: number;
  privateMessage:  number;
  giftSent:        number;
  giftReceived:    number;
  photoUploaded:   number;
  referral:        number;
  phoneCallSecond: number;
  gamePlayed:      number;
  gameWon:         number;
  // Anti-flood throttle for chat XP
  chatThrottleMinGapMs:  number;
  chatThrottlePerMinCap: number;
  // Minimum message length (characters, after trim) required to earn chat XP.
  // Short messages like "ok", "iya" get 0 XP but still send normally.
  chatMinLengthForXp:    number;
}

export const XP_DEFAULTS: XpConfig = {
  chatRoomMessage: 3,
  privateMessage:  1,
  giftSent:        50,
  giftReceived:    50,
  photoUploaded:   100,
  referral:        33,
  phoneCallSecond: 1,
  gamePlayed:      8,
  gameWon:         35,
  chatThrottleMinGapMs:  4000,
  chatThrottlePerMinCap: 12,
  chatMinLengthForXp:    100,
};

const SETTING_PREFIX = "xp.";
const CACHE_TTL_MS   = 15_000;

let cached: XpConfig = { ...XP_DEFAULTS };
let cachedAt = 0;
let loadingPromise: Promise<XpConfig> | null = null;

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS system_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function parseNum(v: string | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function loadFromDb(): Promise<XpConfig> {
  const next: XpConfig = { ...XP_DEFAULTS };
  try {
    await ensureTable();
    const r = await db.execute(sql`
      SELECT key, value FROM system_settings WHERE key LIKE 'xp.%'
    `);
    const map = new Map<string, string>();
    for (const row of r.rows as Array<{ key: string; value: string }>) {
      map.set(row.key, row.value);
    }
    for (const key of Object.keys(XP_DEFAULTS) as Array<keyof XpConfig>) {
      const raw = map.get(`${SETTING_PREFIX}${key}`);
      (next as any)[key] = parseNum(raw, XP_DEFAULTS[key]);
    }
  } catch (err) {
    // settings table missing or DB hiccup — fall back to defaults
  }
  cached = next;
  cachedAt = Date.now();
  return next;
}

/** Returns the latest XP config, refreshing from DB on TTL expiry. */
export async function getXpConfig(): Promise<XpConfig> {
  if (Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  if (!loadingPromise) {
    loadingPromise = loadFromDb().finally(() => {
      loadingPromise = null;
    });
  }
  return loadingPromise;
}

/** Synchronous accessor — returns the last cached value (or defaults). */
export function getXpConfigSync(): XpConfig {
  return cached;
}

/** Force the next read to re-fetch from DB (call after admin updates). */
export function invalidateXpConfigCache(): void {
  cachedAt = 0;
}

/** Persist a partial XP config patch to system_settings. Returns the new config. */
export async function updateXpConfig(patch: Partial<XpConfig>): Promise<XpConfig> {
  await ensureTable();
  const validKeys = Object.keys(XP_DEFAULTS) as Array<keyof XpConfig>;
  for (const k of validKeys) {
    if (patch[k] == null) continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < 0) continue;
    const fullKey = `${SETTING_PREFIX}${k}`;
    const valStr  = String(n);
    await db.execute(sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (${fullKey}, ${valStr}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `);
  }
  invalidateXpConfigCache();
  return getXpConfig();
}

// Warm the cache on module load so the first award doesn't pay the latency.
loadFromDb().catch(() => {});
