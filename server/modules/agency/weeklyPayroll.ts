/**
 * weeklyPayroll.ts
 *
 * Sistem gaji agency — MANUAL ONLY (tidak ada cron otomatis).
 * Admin trigger via POST /api/agency/payroll/run dari admin panel.
 *
 * Safeguard double-payment: menggunakan week_key (format YYYY-WW)
 * sehingga tidak bisa dobel meski server restart berkali-kali.
 *
 * Daily snapshot: setiap hari 00:01 WIB, sistem merekam pendapatan
 * harian semua host per agency ke tabel agency_daily_earnings.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import { broadcastToUsername } from "../../gateway";
import { log } from "../../logger";

// ── ISO Week Key helper ────────────────────────────────────────────────────────
// Returns "YYYY-Www" (e.g. "2026-W21") for a given date in WIB (UTC+7)
function getISOWeekKey(date: Date): string {
  const WIB_MS = 7 * 60 * 60 * 1000;
  const wibDate = new Date(date.getTime() + WIB_MS);

  // ISO week: week containing Thursday
  const tempDate = new Date(Date.UTC(wibDate.getUTCFullYear(), wibDate.getUTCMonth(), wibDate.getUTCDate()));
  const dayOfWeek = tempDate.getUTCDay() || 7; // 1=Mon … 7=Sun
  tempDate.setUTCDate(tempDate.getUTCDate() + 4 - dayOfWeek); // nearest Thursday
  const yearStart = new Date(Date.UTC(tempDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tempDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${tempDate.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ── DB migration ──────────────────────────────────────────────────────────────
export async function ensurePayrollSchema(): Promise<void> {
  // Add period & type columns to agency_commission_payments
  await db.execute(sql`
    ALTER TABLE agency_commission_payments
      ADD COLUMN IF NOT EXISTS period_start  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS period_end    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS payment_type  VARCHAR(20) NOT NULL DEFAULT 'manual'
  `).catch(() => {});

  // Payroll run log — add week_key column for idempotent safeguard
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agency_payroll_runs (
      id               SERIAL PRIMARY KEY,
      run_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      period_start     TIMESTAMPTZ NOT NULL,
      period_end       TIMESTAMPTZ NOT NULL,
      week_key         VARCHAR(10)  NOT NULL DEFAULT '',
      agencies_paid    INTEGER     NOT NULL DEFAULT 0,
      total_diamonds   BIGINT      NOT NULL DEFAULT 0,
      triggered_by     VARCHAR(60) NOT NULL DEFAULT 'cron'
    )
  `).catch(() => {});

  // Add week_key to existing tables (safe ALTER)
  await db.execute(sql`
    ALTER TABLE agency_payroll_runs ADD COLUMN IF NOT EXISTS week_key VARCHAR(10) NOT NULL DEFAULT ''
  `).catch(() => {});

  // Unique index on week_key to prevent DB-level double-insert
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_week_key
    ON agency_payroll_runs (week_key)
    WHERE week_key != ''
  `).catch(() => {});

  // Daily earnings snapshot table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agency_daily_earnings (
      id               SERIAL PRIMARY KEY,
      agency_id        INTEGER     NOT NULL,
      agency_name      VARCHAR(120) NOT NULL DEFAULT '',
      owner_username   VARCHAR(60)  NOT NULL DEFAULT '',
      earn_date        DATE        NOT NULL,
      total_host_earned BIGINT     NOT NULL DEFAULT 0,
      commission_diamonds BIGINT   NOT NULL DEFAULT 0,
      commission_pct   INTEGER     NOT NULL DEFAULT 10,
      host_count       INTEGER     NOT NULL DEFAULT 0,
      snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(agency_id, earn_date)
    )
  `).catch(() => {});

  log("Payroll schema ensured", "payroll");
}

// ── Hitung batas Senin 00:00 WIB dari tanggal tertentu ───────────────────────
// Selalu return Senin paling dekat yang SEBELUM atau SAMA dengan tanggal input
function getMondayStartWIB(referenceDate: Date): Date {
  const WIB_MS  = 7 * 60 * 60 * 1000;
  const wibMs   = referenceDate.getTime() + WIB_MS;
  const wibDate = new Date(wibMs);

  // wibDay: 0=Sun,1=Mon,...,6=Sat
  const wibDay = wibDate.getUTCDay();
  const daysSinceMonday = wibDay === 0 ? 6 : wibDay - 1;

  // Senin 00:00:00.000 WIB = Senin 00:00:00 UTC+7
  const mondayWIB = new Date(Date.UTC(
    wibDate.getUTCFullYear(),
    wibDate.getUTCMonth(),
    wibDate.getUTCDate() - daysSinceMonday,
    0, 0, 0, 0,
  ));
  // Convert to UTC: subtract 7h
  return new Date(mondayWIB.getTime() - WIB_MS);
}

// ── Periode minggu lalu: Senin 00:00 WIB → Minggu 23:59:59.999 WIB ───────────
// Selalu minggu kalender SEBELUMNYA (Mon-Sun), bukan rolling 7 hari.
export function getLastWeekPeriod(): { start: Date; end: Date; weekKey: string } {
  const now = new Date();

  // Senin minggu ini 00:00 WIB
  const thisMondayUTC = getMondayStartWIB(now);

  // Senin minggu lalu 00:00 WIB = thisMondayUTC - 7 hari
  const lastMondayUTC = new Date(thisMondayUTC.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Minggu minggu lalu 23:59:59.999 WIB = thisMondayUTC - 1ms
  const lastSundayUTC = new Date(thisMondayUTC.getTime() - 1);

  const weekKey = getISOWeekKey(lastMondayUTC);
  return { start: lastMondayUTC, end: lastSundayUTC, weekKey };
}

// ── Periode minggu berjalan: Senin minggu ini 00:00 WIB → sekarang ────────────
export function getCurrentWeekPeriod(): { start: Date; end: Date; weekKey: string } {
  const now = new Date();
  const thisMondayUTC = getMondayStartWIB(now);
  const weekKey = getISOWeekKey(now);
  return { start: thisMondayUTC, end: now, weekKey };
}

// ── Core payroll function ─────────────────────────────────────────────────────
export async function runWeeklyPayroll(triggeredBy = "manual"): Promise<{
  agenciesPaid: number;
  totalDiamonds: number;
  details: Array<{ agencyId: number; agencyName: string; ownerUsername: string; diamonds: number }>;
  alreadyRan?: boolean;
  existingRun?: { run_at: string; agencies_paid: number; total_diamonds: number; triggered_by: string; week_key: string };
}> {
  const { start: periodStart, end: periodEnd, weekKey } = getLastWeekPeriod();

  // ── Safeguard: cek week_key (tidak bergantung timestamp) ──────────────────
  const existing = await db.execute(sql`
    SELECT id, run_at, agencies_paid, total_diamonds, triggered_by, week_key
    FROM agency_payroll_runs
    WHERE week_key = ${weekKey}
    LIMIT 1
  `);

  if (existing.rows.length > 0) {
    const prev = existing.rows[0] as any;
    log(`[payroll] BLOCKED — week ${weekKey} sudah dijalankan pada ${prev.run_at} oleh ${prev.triggered_by}. Skipping.`, "payroll");
    return {
      agenciesPaid: 0,
      totalDiamonds: 0,
      details: [],
      alreadyRan: true,
      existingRun: {
        run_at:         prev.run_at,
        agencies_paid:  Number(prev.agencies_paid),
        total_diamonds: Number(prev.total_diamonds),
        triggered_by:   prev.triggered_by,
        week_key:       prev.week_key,
      },
    };
  }

  log(`[payroll] Running payroll | week: ${weekKey} | period: ${periodStart.toISOString()} → ${periodEnd.toISOString()} | by: ${triggeredBy}`, "payroll");

  const agencies = await db.execute(sql`
    SELECT id, agency_name, registered_by, commission
    FROM agencies
    WHERE status = 'approved' AND registered_by IS NOT NULL AND registered_by != ''
    ORDER BY id ASC
  `);

  let agenciesPaid  = 0;
  let totalDiamonds = 0;
  const details: Array<{ agencyId: number; agencyName: string; ownerUsername: string; diamonds: number }> = [];

  for (const row of agencies.rows as any[]) {
    const agencyId      = Number(row.id);
    const agencyName    = String(row.agency_name);
    const ownerUsername = String(row.registered_by);
    const commissionPct = Number(row.commission ?? 10);

    try {
      const earnedRes = await db.execute(sql`
        SELECT COALESCE(SUM(dt.amount), 0) AS weekly_earned
        FROM agency_hosts ah
        JOIN diamond_transactions dt
          ON LOWER(dt.username) = LOWER(ah.username)
          AND dt.type = 'GIFT_RECEIVED'
          AND dt.created_at >= ${periodStart}
          AND dt.created_at <= ${periodEnd}
        WHERE ah.agency_id = ${agencyId}
          AND ah.status = 'active'
      `);
      const weeklyEarned = Number((earnedRes.rows[0] as any)?.weekly_earned ?? 0);

      if (weeklyEarned <= 0) {
        log(`[payroll] Agency #${agencyId} (${agencyName}): 0 earned this week, skip`, "payroll");
        continue;
      }

      const commissionDiamonds = Math.floor(weeklyEarned * commissionPct / 100);
      if (commissionDiamonds <= 0) continue;

      const refId = `PAYROLL-${weekKey}-${agencyId}`;

      const updateRes = await db.execute(sql`
        UPDATE users
        SET diamond_balance = COALESCE(diamond_balance, 0) + ${commissionDiamonds}
        WHERE LOWER(username) = LOWER(${ownerUsername})
        RETURNING diamond_balance
      `);
      const newBalance = Number((updateRes.rows[0] as any)?.diamond_balance ?? 0);

      await db.execute(sql`
        INSERT INTO diamond_transactions
          (username, type, amount, description, reference, running_balance)
        VALUES
          (${ownerUsername}, 'AGENCY_COMMISSION', ${commissionDiamonds},
           ${'Gaji mingguan agency ' + agencyName + ' — ' + weekKey + ' (host earned ' + weeklyEarned.toLocaleString('id-ID') + ' 💎 | ' + commissionPct + '%)'},
           ${refId}, ${newBalance})
      `);

      await db.execute(sql`
        INSERT INTO agency_commission_payments
          (agency_id, owner_username, total_host_earned, commission_diamonds, paid_by_admin, period_start, period_end, payment_type)
        VALUES
          (${agencyId}, ${ownerUsername}, ${weeklyEarned}, ${commissionDiamonds},
           ${triggeredBy}, ${periodStart}, ${periodEnd}, 'weekly_auto')
      `);

      try {
        broadcastToUsername(ownerUsername, {
          type:    "DIAMOND_WITHDRAW_STATUS",
          status:  "approved",
          refId,
          amount:  commissionDiamonds,
          idrValue: 0,
          notes:   `💰 Gaji mingguan agency ${agencyName} masuk! Host earned: ${weeklyEarned.toLocaleString('id-ID')} 💎 | Komisi ${commissionPct}%: +${commissionDiamonds.toLocaleString('id-ID')} 💎`,
        });
      } catch {}

      try {
        broadcastToUsername(ownerUsername, {
          type:    "ALERT",
          title:   "💰 Gaji Agency Masuk!",
          message: `Gaji mingguan agency ${agencyName} (${weekKey}) sebesar 💎 ${commissionDiamonds.toLocaleString('id-ID')} sudah masuk ke balance kamu! (${commissionPct}% dari ${weeklyEarned.toLocaleString('id-ID')} 💎 host)`,
        } as any);
      } catch {}

      agenciesPaid++;
      totalDiamonds += commissionDiamonds;
      details.push({ agencyId, agencyName, ownerUsername, diamonds: commissionDiamonds });

      log(`[payroll] Paid agency #${agencyId} (${agencyName}) → @${ownerUsername}: +${commissionDiamonds} 💎 (${commissionPct}% of ${weeklyEarned}) [${weekKey}]`, "payroll");

    } catch (err: any) {
      log(`[payroll] ERROR agency #${agencyId}: ${err?.message}`, "payroll");
    }
  }

  // Simpan run dengan week_key — unique index mencegah double insert
  await db.execute(sql`
    INSERT INTO agency_payroll_runs
      (period_start, period_end, week_key, agencies_paid, total_diamonds, triggered_by)
    VALUES
      (${periodStart}, ${periodEnd}, ${weekKey}, ${agenciesPaid}, ${totalDiamonds}, ${triggeredBy})
    ON CONFLICT (week_key) DO NOTHING
  `).catch(() => {});

  log(`[payroll] Done! Paid ${agenciesPaid} agencies, total ${totalDiamonds} 💎 [${weekKey}]`, "payroll");

  return { agenciesPaid, totalDiamonds, details };
}

// ── Daily Earnings Snapshot ───────────────────────────────────────────────────
// Rekam pendapatan harian semua host per agency ke agency_daily_earnings.
// Bisa dipanggil manual (POST /api/agency/payroll/snapshot-today) atau otomatis tiap hari.
export async function runDailyEarningsSnapshot(targetDate?: Date): Promise<{
  agenciesProcessed: number;
  totalEarned: number;
}> {
  const WIB_MS  = 7 * 60 * 60 * 1000;
  const now     = targetDate ?? new Date();

  // Date in WIB
  const wibNow  = new Date(now.getTime() + WIB_MS);
  const earnDate = wibNow.toISOString().split("T")[0]; // "YYYY-MM-DD"

  // Period: 00:00:00 WIB → 23:59:59.999 WIB for that date
  const dayStartWIB = new Date(`${earnDate}T00:00:00.000+07:00`);
  const dayEndWIB   = new Date(`${earnDate}T23:59:59.999+07:00`);

  log(`[daily-snapshot] Running for date ${earnDate} (${dayStartWIB.toISOString()} → ${dayEndWIB.toISOString()})`, "payroll");

  const agencies = await db.execute(sql`
    SELECT id, agency_name, registered_by, commission
    FROM agencies
    WHERE status = 'approved'
    ORDER BY id ASC
  `);

  let agenciesProcessed = 0;
  let totalEarned       = 0;

  for (const row of agencies.rows as any[]) {
    const agencyId      = Number(row.id);
    const agencyName    = String(row.agency_name);
    const ownerUsername = String(row.registered_by ?? "");
    const commissionPct = Number(row.commission ?? 10);

    try {
      const earnedRes = await db.execute(sql`
        SELECT
          COALESCE(SUM(dt.amount), 0) AS day_earned,
          COUNT(DISTINCT ah.username)  AS host_count
        FROM agency_hosts ah
        JOIN diamond_transactions dt
          ON LOWER(dt.username) = LOWER(ah.username)
          AND dt.type = 'GIFT_RECEIVED'
          AND dt.created_at >= ${dayStartWIB}
          AND dt.created_at <= ${dayEndWIB}
        WHERE ah.agency_id = ${agencyId}
          AND ah.status = 'active'
      `);
      const dayEarned  = Number((earnedRes.rows[0] as any)?.day_earned ?? 0);
      const hostCount  = Number((earnedRes.rows[0] as any)?.host_count ?? 0);
      const commDiamonds = Math.floor(dayEarned * commissionPct / 100);

      await db.execute(sql`
        INSERT INTO agency_daily_earnings
          (agency_id, agency_name, owner_username, earn_date, total_host_earned, commission_diamonds, commission_pct, host_count, snapshot_at)
        VALUES
          (${agencyId}, ${agencyName}, ${ownerUsername}, ${earnDate}::DATE,
           ${dayEarned}, ${commDiamonds}, ${commissionPct}, ${hostCount}, NOW())
        ON CONFLICT (agency_id, earn_date) DO UPDATE SET
          total_host_earned   = EXCLUDED.total_host_earned,
          commission_diamonds = EXCLUDED.commission_diamonds,
          host_count          = EXCLUDED.host_count,
          snapshot_at         = EXCLUDED.snapshot_at
      `);

      agenciesProcessed++;
      totalEarned += dayEarned;

    } catch (err: any) {
      log(`[daily-snapshot] ERROR agency #${agencyId}: ${err?.message}`, "payroll");
    }
  }

  log(`[daily-snapshot] Done! ${agenciesProcessed} agencies, total earned ${totalEarned} 💎 on ${earnDate}`, "payroll");
  return { agenciesProcessed, totalEarned };
}

// ── Daily Snapshot Scheduler (00:01 WIB setiap hari) ─────────────────────────
function msUntilNextMidnightWIB(): number {
  const now     = new Date();
  const WIB_MS  = 7 * 60 * 60 * 1000;
  const wibNow  = new Date(now.getTime() + WIB_MS);

  // Next midnight WIB = today in WIB + 1 day at 00:01:00
  const nextMidnightWIB = new Date(Date.UTC(
    wibNow.getUTCFullYear(),
    wibNow.getUTCMonth(),
    wibNow.getUTCDate() + 1,
    0, 1, 0, 0, // 00:01:00 WIB
  ));
  // Convert back to UTC: subtract 7 hours
  const nextMidnightUTC = new Date(nextMidnightWIB.getTime() - WIB_MS);
  return Math.max(nextMidnightUTC.getTime() - now.getTime(), 60_000);
}

function scheduleDailySnapshot(): void {
  const ms    = msUntilNextMidnightWIB();
  const hours = Math.round(ms / 3600000);
  log(`[daily-snapshot] Next snapshot scheduled in ~${hours} hours (00:01 WIB)`, "payroll");

  setTimeout(async () => {
    try {
      await runDailyEarningsSnapshot();
    } catch (err: any) {
      log(`[daily-snapshot] Error: ${err?.message}`, "payroll");
    }
    scheduleDailySnapshot(); // schedule next day
  }, ms);
}

// ── Init: setup schema + start daily snapshot scheduler ──────────────────────
// Payroll mingguan TIDAK otomatis — harus di-trigger manual dari admin panel.
export function startPayrollSystem(): void {
  ensurePayrollSchema()
    .then(async () => {
      // Run today's snapshot on startup (catch-up jika server baru restart)
      try {
        await runDailyEarningsSnapshot();
      } catch (err: any) {
        log(`[daily-snapshot] Startup snapshot error: ${err?.message}`, "payroll");
      }
      // Schedule daily auto-snapshot at 00:01 WIB
      scheduleDailySnapshot();
      log("[payroll] System started — weekly payroll is MANUAL ONLY. Daily snapshot is automatic.", "payroll");
    })
    .catch((err: any) => log(`[payroll] Schema init error: ${err?.message}`, "payroll"));
}

// Backward-compat export alias (used in index.ts)
export const startWeeklyPayrollCron = startPayrollSystem;
