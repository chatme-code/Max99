import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { sql } from "drizzle-orm";
import { broadcastToUsername } from "../../gateway";
import { runWeeklyPayroll } from "./weeklyPayroll";

// ── Helper: generate unique agency code ──────────────────────────────────────
function buildCode(agencyName: string): string {
  const prefix = agencyName.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) || 'AGC';
  const year   = new Date().getFullYear();
  return `${prefix}${year}`;
}

async function generateUniqueCode(agencyName: string): Promise<string> {
  const base = buildCode(agencyName);
  // Try base first, then with 2-digit suffix up to 10 attempts
  for (let i = 0; i < 10; i++) {
    const code = i === 0 ? base : base + String(10 + Math.floor(Math.random() * 90));
    const existing = await db.execute(sql`SELECT id FROM agencies WHERE agency_code = ${code} LIMIT 1`);
    if (!existing.rows.length) return code;
  }
  return base + Date.now().toString().slice(-4);
}

export function registerAgencyRoutes(app: Express): void {

  // Ensure agencies table + registered_by column exists
  // Normalize all existing agencies to 10% commission
  db.execute(sql`UPDATE agencies SET commission = 10 WHERE commission != 10`).catch(() => {});

  db.execute(sql`
    CREATE TABLE IF NOT EXISTS agencies (
      id            SERIAL PRIMARY KEY,
      agency_name   VARCHAR(120) NOT NULL,
      logo_url      TEXT,
      whatsapp      VARCHAR(30) NOT NULL,
      country       VARCHAR(60) NOT NULL,
      member_count  INTEGER NOT NULL DEFAULT 0,
      commission    INTEGER NOT NULL DEFAULT 10,
      status        VARCHAR(20) NOT NULL DEFAULT 'pending',
      notes         TEXT,
      registered_by VARCHAR(60),
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at   TIMESTAMPTZ,
      reviewed_by   VARCHAR(60)
    )
  `).catch(console.error);

  // Ensure registered_by column exists on old tables (safe ALTER)
  db.execute(sql`
    ALTER TABLE agencies ADD COLUMN IF NOT EXISTS registered_by VARCHAR(60)
  `).catch(console.error);

  // Ensure agency_code column (unique invite code for each agency)
  db.execute(sql`
    ALTER TABLE agencies ADD COLUMN IF NOT EXISTS agency_code VARCHAR(30) UNIQUE
  `).catch(console.error);

  // Ensure agency_join_requests table exists
  db.execute(sql`
    CREATE TABLE IF NOT EXISTS agency_join_requests (
      id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_id    INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      username     VARCHAR(60) NOT NULL,
      status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
      message      TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at  TIMESTAMPTZ,
      reviewed_by  VARCHAR(60),
      UNIQUE (agency_id, username)
    )
  `).catch(console.error);

  // Ensure agency_hosts table exists
  db.execute(sql`
    CREATE TABLE IF NOT EXISTS agency_hosts (
      id         SERIAL PRIMARY KEY,
      agency_id  INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      username   VARCHAR(60) NOT NULL,
      role       VARCHAR(30) NOT NULL DEFAULT 'host',
      status     VARCHAR(20) NOT NULL DEFAULT 'active',
      added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(agency_id, username)
    )
  `).catch(console.error);

  // ── GET /api/agency/my ────────────────────────────────────────────────────
  // Returns the approved agency for the currently logged-in user
  app.get("/api/agency/my", async (req: Request, res: Response) => {
    if (!req.session?.userId) {
      return res.status(401).json({ message: "Not logged in" });
    }
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const result = await db.execute(sql`
        SELECT id, agency_name, logo_url, whatsapp, country, member_count,
               commission, status, registered_at, agency_code
        FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
        ORDER BY registered_at DESC
        LIMIT 1
      `);
      if (!result.rows.length) {
        return res.json({ agency: null });
      }
      return res.json({ agency: result.rows[0] });
    } catch (e: any) {
      console.error("[agency/my]", e?.message);
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── GET /api/agency/my/stats ──────────────────────────────────────────────
  // Returns host count + sub-agency invite count for owner's agency
  app.get("/api/agency/my/stats", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const agencyRes = await db.execute(sql`
        SELECT id FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
        LIMIT 1
      `);
      if (!agencyRes.rows.length) return res.json({ hostCount: 0, subAgencyCount: 0 });

      const agencyId = (agencyRes.rows[0] as any).id;
      const hostRes = await db.execute(sql`
        SELECT COUNT(*) AS cnt FROM agency_hosts
        WHERE agency_id = ${agencyId} AND status = 'active'
      `);
      const hostCount = parseInt((hostRes.rows[0] as any)?.cnt ?? "0", 10);

      return res.json({ hostCount, subAgencyCount: 0 });
    } catch (e: any) {
      console.error("[agency/my/stats]", e?.message);
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── GET /api/agency/my/hosts ──────────────────────────────────────────────
  app.get("/api/agency/my/hosts", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const agencyRes = await db.execute(sql`
        SELECT id FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
        LIMIT 1
      `);
      if (!agencyRes.rows.length) return res.json({ hosts: [] });

      const agencyId = (agencyRes.rows[0] as any).id;
      const hosts = await db.execute(sql`
        SELECT username, role, status, added_at
        FROM agency_hosts
        WHERE agency_id = ${agencyId}
        ORDER BY added_at DESC
      `);
      return res.json({ hosts: hosts.rows });
    } catch (e: any) {
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── POST /api/agency/my/hosts ─────────────────────────────────────────────
  // Add a host to the agency by username
  app.post("/api/agency/my/hosts", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    const { username: targetUsername } = req.body;
    if (!targetUsername?.trim()) return res.status(400).json({ message: "Username required" });

    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const agencyRes = await db.execute(sql`
        SELECT id FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
        LIMIT 1
      `);
      if (!agencyRes.rows.length) return res.status(403).json({ message: "You don't have an approved agency" });

      const agencyId = (agencyRes.rows[0] as any).id;
      await db.execute(sql`
        INSERT INTO agency_hosts (agency_id, username, role, status)
        VALUES (${agencyId}, ${targetUsername.trim()}, 'host', 'active')
        ON CONFLICT (agency_id, username) DO UPDATE SET status = 'active'
      `);
      return res.json({ success: true, message: `${targetUsername} added as host.` });
    } catch (e: any) {
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── DELETE /api/agency/my/hosts/:username ────────────────────────────────
  app.delete("/api/agency/my/hosts/:username", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const agencyRes = await db.execute(sql`
        SELECT id FROM agencies WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved' LIMIT 1
      `);
      if (!agencyRes.rows.length) return res.status(403).json({ message: "No approved agency" });

      const agencyId = (agencyRes.rows[0] as any).id;
      await db.execute(sql`
        DELETE FROM agency_hosts WHERE agency_id = ${agencyId} AND username = ${req.params.username}
      `);
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── Ensure agency_commission_payments table ───────────────────────────────
  // Records when admin (platform) pays 10% commission to an agency owner
  db.execute(sql`
    CREATE TABLE IF NOT EXISTS agency_commission_payments (
      id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      agency_id         INTEGER NOT NULL,
      owner_username    TEXT NOT NULL,
      total_host_earned BIGINT NOT NULL,
      commission_diamonds BIGINT NOT NULL,
      paid_by_admin     TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(console.error);

  // ── GET /api/agency/my/hosts/stats ────────────────────────────────────────
  // Returns each host's total GIFT_RECEIVED diamonds (all-time + this week),
  // plus agency-level commission totals (owed by platform to agency owner).
  app.get("/api/agency/my/hosts/stats", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const agencyRes = await db.execute(sql`
        SELECT id, commission FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
        LIMIT 1
      `);
      if (!agencyRes.rows.length) {
        return res.json({ hosts: [], totalEarned: 0, commissionEarned: 0, commissionPaid: 0, commissionOwed: 0, weeklyEarned: 0 });
      }
      const agencyId  = (agencyRes.rows[0] as any).id;
      const commPct   = Number((agencyRes.rows[0] as any).commission ?? 10);

      // Periode minggu ini (Senin 00:00 WIB → sekarang) — sama persis dengan weekly-stats
      const { getCurrentWeekPeriod } = await import("./weeklyPayroll");
      const cur = getCurrentWeekPeriod();

      const hostsRes = await db.execute(sql`
        SELECT
          h.username, h.role, h.status, h.added_at,
          COALESCE(SUM(CASE WHEN dt.type = 'GIFT_RECEIVED' THEN dt.amount ELSE 0 END), 0) AS total_earned,
          COALESCE(SUM(CASE WHEN dt.type = 'GIFT_RECEIVED'
                                AND dt.created_at >= ${cur.start}
                                AND dt.created_at <= ${cur.end}
                           THEN dt.amount ELSE 0 END), 0) AS weekly_earned,
          -- Gaji pokok contract info (NULL jika tidak terdaftar)
          sc.id             AS sc_id,
          sc.salary_level   AS sc_level,
          sc.agency_name    AS sc_agency_name,
          sc.status         AS sc_status,
          -- Coin minggu ini dari party_income_log (untuk progress target gapok)
          COALESCE((
            SELECT SUM(pil.coin_amount)
            FROM party_income_log pil
            JOIN party_rooms pr ON pr.id = pil.room_id
            WHERE LOWER(pr.creator_username) = LOWER(h.username)
              AND pil.created_at >= ${cur.start}
              AND pil.created_at <= ${cur.end}
          ), 0) AS weekly_coin
        FROM agency_hosts h
        LEFT JOIN diamond_transactions dt ON LOWER(dt.username) = LOWER(h.username)
          AND dt.type = 'GIFT_RECEIVED'
        LEFT JOIN host_salary_contracts sc ON LOWER(sc.username) = LOWER(h.username)
          AND sc.status = 'active'
        WHERE h.agency_id = ${agencyId}
        GROUP BY h.username, h.role, h.status, h.added_at,
                 sc.id, sc.salary_level, sc.agency_name, sc.status
        ORDER BY weekly_earned DESC, total_earned DESC
      `);

      const hosts = hostsRes.rows.map((r: any) => ({
        username:       r.username,
        role:           r.role,
        status:         r.status,
        added_at:       r.added_at,
        total_earned:   Number(r.total_earned ?? 0),
        weekly_earned:  Number(r.weekly_earned ?? 0),
        weekly_coin:    Number(r.weekly_coin ?? 0),
        // Gaji pokok fields — null jika tidak terdaftar
        sc_id:          r.sc_id ?? null,
        sc_level:       r.sc_level ?? null,
        sc_agency_name: r.sc_agency_name ?? null,
      }));

      const totalEarned  = hosts.reduce((a: number, h: any) => a + h.total_earned, 0);
      const weeklyEarned = hosts.reduce((a: number, h: any) => a + h.weekly_earned, 0);

      // Commission = commPct% of total host earnings (all-time), paid by platform
      const commissionEarned = Math.floor(totalEarned * commPct / 100);
      const commPaidRes = await db.execute(sql`
        SELECT COALESCE(SUM(commission_diamonds), 0) AS total_paid
        FROM agency_commission_payments
        WHERE agency_id = ${agencyId}
      `);
      const commissionPaid = Number((commPaidRes.rows[0] as any)?.total_paid ?? 0);
      const commissionOwed = Math.max(0, commissionEarned - commissionPaid);

      return res.json({ hosts, totalEarned, weeklyEarned, commissionEarned, commissionPaid, commissionOwed, commPct, weekStart: cur.start, weekEnd: cur.end });
    } catch (e: any) {
      console.error("[agency/my/hosts/stats]", e?.message);
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── GET /api/agency/my/weekly-stats ──────────────────────────────────────────
  // Minggu ini (Senin 00:00 WIB → sekarang) + minggu lalu (Senin→Minggu WIB)
  // untuk ditampilkan di dashboard agency owner di app.
  app.get("/api/agency/my/weekly-stats", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const { getCurrentWeekPeriod, getLastWeekPeriod } = await import("./weeklyPayroll");
      const cur  = getCurrentWeekPeriod();
      const prev = getLastWeekPeriod();

      const agencyRes = await db.execute(sql`
        SELECT id, commission FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
        LIMIT 1
      `);
      if (!agencyRes.rows.length) {
        return res.json({
          current_week: { start: cur.start, end: cur.end, week_key: cur.weekKey, earned: 0, commission: 0, host_count: 0 },
          prev_week:    { start: prev.start, end: prev.end, week_key: prev.weekKey, earned: 0, commission: 0, paid: false },
        });
      }
      const agencyId  = Number((agencyRes.rows[0] as any).id);
      const commPct   = Number((agencyRes.rows[0] as any).commission ?? 10);

      const [curRes, prevRes, paidRes] = await Promise.all([
        db.execute(sql`
          SELECT COALESCE(SUM(dt.amount),0) AS earned, COUNT(DISTINCT ah.username) AS host_count
          FROM agency_hosts ah
          JOIN diamond_transactions dt
            ON LOWER(dt.username) = LOWER(ah.username)
            AND dt.type = 'GIFT_RECEIVED'
            AND dt.created_at >= ${cur.start} AND dt.created_at <= ${cur.end}
          WHERE ah.agency_id = ${agencyId} AND ah.status = 'active'
        `),
        db.execute(sql`
          SELECT COALESCE(SUM(dt.amount),0) AS earned, COUNT(DISTINCT ah.username) AS host_count
          FROM agency_hosts ah
          JOIN diamond_transactions dt
            ON LOWER(dt.username) = LOWER(ah.username)
            AND dt.type = 'GIFT_RECEIVED'
            AND dt.created_at >= ${prev.start} AND dt.created_at <= ${prev.end}
          WHERE ah.agency_id = ${agencyId} AND ah.status = 'active'
        `),
        db.execute(sql`
          SELECT COUNT(*) AS cnt FROM agency_payroll_runs WHERE week_key = ${prev.weekKey} LIMIT 1
        `),
      ]);

      const curEarned    = Number((curRes.rows[0] as any)?.earned ?? 0);
      const curHosts     = Number((curRes.rows[0] as any)?.host_count ?? 0);
      const prevEarned   = Number((prevRes.rows[0] as any)?.earned ?? 0);
      const prevHosts    = Number((prevRes.rows[0] as any)?.host_count ?? 0);
      const prevPaid     = Number((paidRes.rows[0] as any)?.cnt ?? 0) > 0;

      return res.json({
        current_week: {
          start:      cur.start,
          end:        cur.end,
          week_key:   cur.weekKey,
          earned:     curEarned,
          commission: Math.floor(curEarned * commPct / 100),
          host_count: curHosts,
        },
        prev_week: {
          start:      prev.start,
          end:        prev.end,
          week_key:   prev.weekKey,
          earned:     prevEarned,
          commission: Math.floor(prevEarned * commPct / 100),
          host_count: prevHosts,
          paid:       prevPaid,
        },
      });
    } catch (e: any) {
      console.error("[agency/my/weekly-stats]", e?.message);
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── POST /api/agency/register ─────────────────────────────────────────────
  // registered_by can be supplied in the request body (entered by the user),
  // or falls back to the session's authenticated username.
  app.post("/api/agency/register", async (req: Request, res: Response) => {
    const { agency_name, whatsapp, country, member_count, commission, logo_url, registered_by: bodyUsername } = req.body;

    if (!agency_name?.trim()) {
      return res.status(400).json({ message: "Agency name is required" });
    }
    if (!whatsapp?.trim()) {
      return res.status(400).json({ message: "WhatsApp number is required" });
    }
    if (!country?.trim()) {
      return res.status(400).json({ message: "Country is required" });
    }
    const commissionNum = 10;

    // Priority: session user → body username (ensures correct casing from DB)
    let registeredBy: string | null = null;
    if (req.session?.userId) {
      try {
        const user = await storage.getUser(req.session.userId);
        if (user) registeredBy = user.username;
      } catch {}
    }
    if (!registeredBy) registeredBy = bodyUsername?.trim() || null;
    if (!registeredBy) {
      return res.status(400).json({ message: "Username is required. Please log in." });
    }

    try {
      const agencyCode = await generateUniqueCode(agency_name.trim());
      const result = await db.execute(sql`
        INSERT INTO agencies (agency_name, logo_url, whatsapp, country, member_count, commission, status, registered_by, agency_code)
        VALUES (
          ${agency_name.trim()},
          ${logo_url ?? null},
          ${whatsapp.trim()},
          ${country.trim()},
          ${parseInt(member_count ?? "0", 10) || 0},
          ${commissionNum},
          'pending',
          ${registeredBy},
          ${agencyCode}
        )
        RETURNING id, agency_name, status, registered_at, agency_code
      `);
      const agency = result.rows[0] as any;
      return res.json({
        success: true,
        message: `Agency "${agency.agency_name}" registered! Our team will review within 24 hours.`,
        agencyId: agency.id,
        agencyCode: agency.agency_code,
      });
    } catch (e: any) {
      console.error("[agency-register]", e?.message);
      return res.status(500).json({ message: "Registration failed. Please try again." });
    }
  });

  // ── GET /api/agency/code-lookup/:code ────────────────────────────────────────
  // Public-ish: look up an agency by its unique code (for join flow)
  app.get("/api/agency/code-lookup/:code", async (req: Request, res: Response) => {
    const code = req.params.code?.trim().toUpperCase();
    if (!code) return res.status(400).json({ message: "Code required" });
    try {
      const result = await db.execute(sql`
        SELECT id, agency_name, logo_url, country, commission, member_count
        FROM agencies
        WHERE UPPER(agency_code) = ${code} AND status = 'approved'
        LIMIT 1
      `);
      if (!result.rows.length) return res.status(404).json({ message: "Kode agency tidak ditemukan atau belum disetujui" });
      return res.json({ agency: result.rows[0] });
    } catch (e: any) {
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── POST /api/agency/join-request ────────────────────────────────────────────
  // User submits a request to join an agency using its code
  app.post("/api/agency/join-request", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    const { code, message: userMessage } = req.body as { code?: string; message?: string };
    if (!code?.trim()) return res.status(400).json({ message: "Agency code required" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      // Check agency exists & approved
      const agRes = await db.execute(sql`
        SELECT id, agency_name FROM agencies
        WHERE UPPER(agency_code) = ${code.trim().toUpperCase()} AND status = 'approved'
        LIMIT 1
      `);
      if (!agRes.rows.length) return res.status(404).json({ message: "Kode agency tidak ditemukan" });
      const agencyId   = (agRes.rows[0] as any).id as number;
      const agencyName = (agRes.rows[0] as any).agency_name as string;

      // Can't join own agency
      const ownRes = await db.execute(sql`
        SELECT id FROM agencies WHERE id = ${agencyId} AND LOWER(registered_by) = LOWER(${user.username}) LIMIT 1
      `);
      if (ownRes.rows.length) return res.status(400).json({ message: "Kamu adalah pemilik agency ini" });

      // Already a host?
      const hostRes = await db.execute(sql`
        SELECT id FROM agency_hosts WHERE agency_id = ${agencyId} AND LOWER(username) = LOWER(${user.username}) LIMIT 1
      `);
      if (hostRes.rows.length) return res.status(400).json({ message: "Kamu sudah menjadi host di agency ini" });

      // Upsert join request (re-apply if previously rejected)
      await db.execute(sql`
        INSERT INTO agency_join_requests (agency_id, username, status, message)
        VALUES (${agencyId}, ${user.username}, 'pending', ${userMessage?.trim() ?? null})
        ON CONFLICT (agency_id, username) DO UPDATE
          SET status = 'pending', message = EXCLUDED.message, requested_at = NOW(), reviewed_at = NULL, reviewed_by = NULL
      `);
      // Notify agency owner
      const ownerRes = await db.execute(sql`SELECT registered_by FROM agencies WHERE id = ${agencyId} LIMIT 1`);
      const ownerUsername = (ownerRes.rows[0] as any)?.registered_by as string | null;
      if (ownerUsername) {
        try {
          await storage.createNotification({
            username: ownerUsername,
            type: "ALERT",
            subject: "Permintaan Join Agency",
            message: `@${user.username} ingin bergabung ke agency "${agencyName}" kamu. Cek menu Agency untuk review.`,
            status: 1,
          });
        } catch {}
      }
      return res.json({ success: true, message: `Permintaan join "${agencyName}" terkirim! Tunggu review dari owner.` });
    } catch (e: any) {
      console.error("[agency/join-request]", e?.message);
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── GET /api/agency/my/join-requests ────────────────────────────────────────
  // Agency owner sees all pending/reviewed requests for their agency
  app.get("/api/agency/my/join-requests", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });
      const agRes = await db.execute(sql`
        SELECT id FROM agencies WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved' LIMIT 1
      `);
      if (!agRes.rows.length) return res.json({ requests: [] });
      const agencyId = (agRes.rows[0] as any).id;
      const reqs = await db.execute(sql`
        SELECT id, username, status, message, requested_at, reviewed_at, reviewed_by
        FROM agency_join_requests
        WHERE agency_id = ${agencyId}
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, requested_at DESC
      `);
      return res.json({ requests: reqs.rows });
    } catch (e: any) {
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── PATCH /api/agency/join-requests/:id ─────────────────────────────────────
  // Agency owner approves or rejects a join request
  app.patch("/api/agency/join-requests/:id", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    const { status, notes } = req.body as { status: string; notes?: string };
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ message: "Invalid status" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      // Verify owner
      const reqRow = await db.execute(sql`
        SELECT r.id, r.username, r.agency_id, a.agency_name, a.registered_by
        FROM agency_join_requests r
        JOIN agencies a ON a.id = r.agency_id
        WHERE r.id = ${req.params.id} LIMIT 1
      `);
      if (!reqRow.rows.length) return res.status(404).json({ message: "Request tidak ditemukan" });
      const row = reqRow.rows[0] as any;
      if (row.registered_by !== user.username) return res.status(403).json({ message: "Bukan owner agency ini" });

      await db.execute(sql`
        UPDATE agency_join_requests
        SET status = ${status}, reviewed_at = NOW(), reviewed_by = ${user.username}
        WHERE id = ${req.params.id}
      `);

      if (status === 'approved') {
        await db.execute(sql`
          INSERT INTO agency_hosts (agency_id, username, role, status)
          VALUES (${row.agency_id}, ${row.username}, 'host', 'active')
          ON CONFLICT (agency_id, username) DO UPDATE SET status = 'active'
        `);
        await db.execute(sql`
          UPDATE agencies SET member_count = member_count + 1 WHERE id = ${row.agency_id}
        `);
      }

      // Notify applicant
      try {
        await storage.createNotification({
          username: row.username,
          type: "ALERT",
          subject: status === 'approved' ? "Permintaan Join Disetujui!" : "Permintaan Join Ditolak",
          message: status === 'approved'
            ? `Selamat! Kamu telah bergabung sebagai host di agency "${row.agency_name}".`
            : `Maaf, permintaan join kamu ke agency "${row.agency_name}" ditolak.${notes ? ' Alasan: ' + notes : ''}`,
          status: 1,
        });
      } catch {}

      return res.json({ success: true, status });
    } catch (e: any) {
      console.error("[agency/join-requests/review]", e?.message);
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── GET /api/agency/my/pending-request ──────────────────────────────────────
  // Any logged-in user can check their own pending join request status
  // ── GET /api/agency/my/is-host ────────────────────────────────────────────
  // Returns { isHost, isOwner, agencyName, agencyCode } for the logged-in user.
  // isHost = true jika user adalah active host ATAU owner agency yang approved.
  app.get("/api/agency/my/is-host", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.json({ isHost: false, isOwner: false, agencyName: null, agencyCode: null });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.json({ isHost: false, isOwner: false, agencyName: null, agencyCode: null });

      // Cek sebagai host terlebih dahulu
      const hostResult = await db.execute(sql`
        SELECT ah.status, a.agency_name, a.agency_code
        FROM agency_hosts ah
        JOIN agencies a ON a.id = ah.agency_id
        WHERE LOWER(ah.username) = LOWER(${user.username})
          AND ah.status = 'active'
        LIMIT 1
      `);
      if (hostResult.rows.length > 0) {
        const row = hostResult.rows[0] as any;
        return res.json({ isHost: true, isOwner: false, agencyName: row.agency_name ?? null, agencyCode: row.agency_code ?? null });
      }

      // Cek sebagai owner agency (registered_by)
      const ownerResult = await db.execute(sql`
        SELECT id, agency_name, agency_code
        FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username})
          AND status = 'approved'
        ORDER BY registered_at DESC
        LIMIT 1
      `);
      if (ownerResult.rows.length > 0) {
        const row = ownerResult.rows[0] as any;
        return res.json({ isHost: true, isOwner: true, agencyName: row.agency_name ?? null, agencyCode: row.agency_code ?? null });
      }

      return res.json({ isHost: false, isOwner: false, agencyName: null, agencyCode: null });
    } catch {
      return res.json({ isHost: false, isOwner: false, agencyName: null, agencyCode: null });
    }
  });

  // ── GET /api/agency/profile/:username ─────────────────────────────────────
  // Public endpoint — returns agency membership info for any user.
  // Used by ViewProfileModal to show the agency badge.
  app.get("/api/agency/profile/:username", async (req: Request, res: Response) => {
    try {
      const { username } = req.params;
      const result = await db.execute(sql`
        SELECT ah.status, a.agency_name, a.agency_code
        FROM agency_hosts ah
        JOIN agencies a ON a.id = ah.agency_id
        WHERE LOWER(ah.username) = LOWER(${username})
          AND ah.status = 'active'
        LIMIT 1
      `);
      if (result.rows.length === 0) return res.json({ isHost: false, agencyName: null });
      const row = result.rows[0] as any;
      return res.json({ isHost: true, agencyName: row.agency_name ?? null });
    } catch {
      return res.json({ isHost: false, agencyName: null });
    }
  });

  app.get("/api/agency/my/pending-request", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });
      const result = await db.execute(sql`
        SELECT r.id, r.status, r.requested_at, r.reviewed_at, a.agency_name, a.agency_code
        FROM agency_join_requests r
        JOIN agencies a ON a.id = r.agency_id
        WHERE r.username = ${user.username}
        ORDER BY r.requested_at DESC
        LIMIT 1
      `);
      return res.json({ request: result.rows[0] ?? null });
    } catch (e: any) {
      return res.status(500).json({ message: "Server error" });
    }
  });

  // ── POST /api/agency/notify ────────────────────────────────────────────────
  // Internal endpoint — called by admin panel after approve/reject
  // Body: { username, subject, message }
  app.post("/api/agency/notify", async (req: Request, res: Response) => {
    const { username, subject, message } = req.body;
    if (!username || !message) {
      return res.status(400).json({ message: "username and message are required" });
    }
    try {
      await storage.createNotification({
        username,
        type: "ALERT",
        subject: subject ?? "max99 official",
        message,
        status: 1, // PENDING
      });

      // Real-time WS push — user hears sound immediately (tanpa tunggu polling 30s)
      try {
        broadcastToUsername(username, {
          type: "ALERT",
          title: subject ?? "Notifikasi",
          message,
        });
      } catch {}

      return res.json({ success: true });
    } catch (e: any) {
      console.error("[agency-notify]", e?.message);
      return res.status(500).json({ message: "Failed to send notification" });
    }
  });

  // ── POST /api/agency/payroll/run ────────────────────────────────────────────
  // Manual trigger untuk admin — jalankan payroll sekarang (tanpa tunggu cron)
  // Header: x-internal-key = process.env.INTERNAL_KEY (opsional, fallback ke no-auth jika tidak diset)
  app.post("/api/agency/payroll/run", async (req: Request, res: Response) => {
    const internalKey = process.env.INTERNAL_KEY;
    const reqKey      = req.headers["x-internal-key"] as string | undefined;
    if (internalKey && reqKey !== internalKey) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const triggeredBy = (req.body?.triggeredBy as string) || "admin-manual";
    try {
      const result = await runWeeklyPayroll(triggeredBy);
      if (result.alreadyRan) {
        return res.status(409).json({
          success: false,
          alreadyRan: true,
          message: "Payroll untuk periode minggu ini sudah pernah dijalankan. Tidak diproses ulang untuk mencegah double-bayar.",
          existingRun: result.existingRun,
        });
      }
      return res.json({ success: true, ...result });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message ?? "Payroll error" });
    }
  });

  // ── GET /api/agency/payroll/current-week ────────────────────────────────────
  // Data minggu berjalan (Senin 00:00 WIB → sekarang) per agency — untuk admin lihat sebelum kirim
  app.get("/api/agency/payroll/current-week", async (_req: Request, res: Response) => {
    try {
      const { getCurrentWeekPeriod, getLastWeekPeriod } = await import("./weeklyPayroll");
      const cur  = getCurrentWeekPeriod();
      const prev = getLastWeekPeriod();

      const agencies = await db.execute(sql`
        SELECT id, agency_name, registered_by, commission
        FROM agencies
        WHERE status = 'approved' AND registered_by IS NOT NULL AND registered_by != ''
        ORDER BY agency_name ASC
      `);

      const currentWeekRows = [];
      let totalEarnedAll = 0;
      let totalCommAll   = 0;

      for (const row of agencies.rows as any[]) {
        const agencyId      = Number(row.id);
        const agencyName    = String(row.agency_name);
        const ownerUsername = String(row.registered_by ?? "");
        const commPct       = Number(row.commission ?? 10);

        // Pendapatan minggu ini (Senin 00:00 WIB → sekarang)
        const curRes = await db.execute(sql`
          SELECT COALESCE(SUM(dt.amount), 0) AS earned,
                 COUNT(DISTINCT ah.username) AS host_count
          FROM agency_hosts ah
          JOIN diamond_transactions dt
            ON LOWER(dt.username) = LOWER(ah.username)
            AND dt.type = 'GIFT_RECEIVED'
            AND dt.created_at >= ${cur.start}
            AND dt.created_at <= ${cur.end}
          WHERE ah.agency_id = ${agencyId} AND ah.status = 'active'
        `);
        const curEarned    = Number((curRes.rows[0] as any)?.earned ?? 0);
        const curHostCount = Number((curRes.rows[0] as any)?.host_count ?? 0);
        const curComm      = Math.floor(curEarned * commPct / 100);

        // Pendapatan minggu lalu (Senin prev → Minggu prev)
        const prevRes = await db.execute(sql`
          SELECT COALESCE(SUM(dt.amount), 0) AS earned
          FROM agency_hosts ah
          JOIN diamond_transactions dt
            ON LOWER(dt.username) = LOWER(ah.username)
            AND dt.type = 'GIFT_RECEIVED'
            AND dt.created_at >= ${prev.start}
            AND dt.created_at <= ${prev.end}
          WHERE ah.agency_id = ${agencyId} AND ah.status = 'active'
        `);
        const prevEarned = Number((prevRes.rows[0] as any)?.earned ?? 0);
        const prevComm   = Math.floor(prevEarned * commPct / 100);

        // Apakah minggu lalu sudah dibayar?
        const paidRes = await db.execute(sql`
          SELECT COUNT(*) AS cnt FROM agency_payroll_runs WHERE week_key = ${prev.weekKey} LIMIT 1
        `);
        const prevPaid = Number((paidRes.rows[0] as any)?.cnt ?? 0) > 0;

        totalEarnedAll += curEarned;
        totalCommAll   += curComm;

        currentWeekRows.push({
          agency_id:         agencyId,
          agency_name:       agencyName,
          owner_username:    ownerUsername,
          commission_pct:    commPct,
          host_count:        curHostCount,
          current_week_earned:  curEarned,
          current_week_comm:    curComm,
          prev_week_earned:     prevEarned,
          prev_week_comm:       prevComm,
          prev_week_paid:       prevPaid,
        });
      }

      return res.json({
        current_week: {
          start:   cur.start,
          end:     cur.end,
          week_key: cur.weekKey,
        },
        prev_week: {
          start:    prev.start,
          end:      prev.end,
          week_key: prev.weekKey,
        },
        agencies: currentWeekRows,
        totals: {
          total_earned:     totalEarnedAll,
          total_commission: totalCommAll,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message ?? "Server error" });
    }
  });

  // ── POST /api/agency/payroll/snapshot-today ─────────────────────────────────
  // Manual trigger snapshot pendapatan harian hari ini
  app.post("/api/agency/payroll/snapshot-today", async (_req: Request, res: Response) => {
    try {
      const { runDailyEarningsSnapshot } = await import("./weeklyPayroll");
      const result = await runDailyEarningsSnapshot();
      return res.json({ success: true, ...result });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message ?? "Snapshot error" });
    }
  });

  // ── GET /api/agency/payroll/daily-earnings ──────────────────────────────────
  app.get("/api/agency/payroll/daily-earnings", async (req: Request, res: Response) => {
    const days     = Math.min(parseInt((req.query.days as string) ?? "30", 10), 90);
    const agencyId = req.query.agency_id ? parseInt(req.query.agency_id as string, 10) : null;
    try {
      const agencyClause = agencyId ? sql`AND de.agency_id = ${agencyId}` : sql``;
      const rows = await db.execute(sql`
        SELECT de.agency_id, de.agency_name, de.owner_username, de.earn_date,
               de.total_host_earned, de.commission_diamonds, de.commission_pct,
               de.host_count, de.snapshot_at
        FROM agency_daily_earnings de
        WHERE de.earn_date >= CURRENT_DATE - ${days}::INTEGER
          ${agencyClause}
        ORDER BY de.earn_date DESC, de.total_host_earned DESC
      `);

      const byDate: Record<string, { date: string; total_earned: number; total_commission: number; agency_count: number }> = {};
      for (const r of rows.rows as any[]) {
        const d = r.earn_date instanceof Date
          ? r.earn_date.toISOString().split("T")[0]
          : String(r.earn_date).split("T")[0];
        if (!byDate[d]) byDate[d] = { date: d, total_earned: 0, total_commission: 0, agency_count: 0 };
        byDate[d].total_earned     += Number(r.total_host_earned ?? 0);
        byDate[d].total_commission += Number(r.commission_diamonds ?? 0);
        byDate[d].agency_count     += 1;
      }
      const dailySummary = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
      return res.json({ rows: rows.rows, daily_summary: dailySummary });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message ?? "Server error" });
    }
  });

  // ── GET /api/agency/payroll/history ────────────────────────────────────────
  app.get("/api/agency/payroll/history", async (_req: Request, res: Response) => {
    try {
      const runs = await db.execute(sql`
        SELECT id, run_at, period_start, period_end, week_key, agencies_paid, total_diamonds, triggered_by
        FROM agency_payroll_runs
        ORDER BY run_at DESC
        LIMIT 52
      `);
      return res.json({ runs: runs.rows });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message ?? "Server error" });
    }
  });

  // ── GET /api/agency/payroll/weekly-detail ──────────────────────────────────
  // Returns each payroll run with per-agency breakdown for the weekly accordion view
  app.get("/api/agency/payroll/weekly-detail", async (_req: Request, res: Response) => {
    try {
      const runs = await db.execute(sql`
        SELECT id, run_at, period_start, period_end, agencies_paid, total_diamonds, triggered_by
        FROM agency_payroll_runs
        ORDER BY run_at DESC
        LIMIT 104
      `);

      const weeks = [];
      for (const run of runs.rows as any[]) {
        const payments = await db.execute(sql`
          SELECT
            p.agency_id,
            a.agency_name,
            p.owner_username,
            p.total_host_earned,
            p.commission_diamonds,
            a.commission AS commission_pct,
            p.created_at
          FROM agency_commission_payments p
          LEFT JOIN agencies a ON a.id = p.agency_id
          WHERE p.period_start = ${run.period_start}
            AND p.period_end   = ${run.period_end}
            AND p.payment_type = 'weekly_auto'
          ORDER BY p.commission_diamonds DESC
        `);

        weeks.push({
          run_id:        run.id,
          run_at:        run.run_at,
          period_start:  run.period_start,
          period_end:    run.period_end,
          agencies_paid: Number(run.agencies_paid ?? 0),
          total_diamonds: Number(run.total_diamonds ?? 0),
          triggered_by:  run.triggered_by,
          agencies: (payments.rows as any[]).map(p => ({
            agency_id:          Number(p.agency_id),
            agency_name:        p.agency_name ?? `Agency #${p.agency_id}`,
            owner_username:     p.owner_username,
            total_host_earned:  Number(p.total_host_earned ?? 0),
            commission_diamonds: Number(p.commission_diamonds ?? 0),
            commission_pct:     Number(p.commission_pct ?? 10),
          })),
        });
      }

      return res.json({ weeks });
    } catch (e: any) {
      return res.status(500).json({ message: e?.message ?? "Server error" });
    }
  });

  // ── GET /api/agency/my/live-sessions ─────────────────────────────────────
  // Durasi live per host — dikelompokkan berdasarkan tanggal (WIB)
  // Query param: days=30 (default 30 hari terakhir)
  app.get("/api/agency/my/live-sessions", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      const agencyRes = await db.execute(sql`
        SELECT id FROM agencies
        WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
        LIMIT 1
      `);
      if (!agencyRes.rows.length) return res.json({ sessions: [], byDate: [] });

      const agencyId = (agencyRes.rows[0] as any).id;

      // Ambil semua host aktif agency ini
      const hostsRes = await db.execute(sql`
        SELECT username FROM agency_hosts
        WHERE agency_id = ${agencyId} AND status = 'active'
      `);
      const hostUsernames: string[] = (hostsRes.rows as any[]).map((h: any) => h.username.toLowerCase());
      // Sertakan owner sendiri
      if (!hostUsernames.includes(user.username.toLowerCase())) {
        hostUsernames.push(user.username.toLowerCase());
      }

      if (!hostUsernames.length) return res.json({ sessions: [], byDate: [] });

      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? '30'), 10)));

      // Ambil sesi live 'days' hari terakhir untuk semua host agency
      // Gunakan JOIN langsung ke agency_hosts + UNION owner untuk hindari array binding issue
      const rows = await db.execute(sql`
        SELECT
          pls.id,
          pls.username,
          pls.room_name,
          pls.room_id,
          pls.seat_index,
          pls.started_at,
          pls.ended_at,
          CASE
            WHEN pls.ended_at IS NOT NULL THEN COALESCE(pls.duration_seconds, 0)
            ELSE GREATEST(0, EXTRACT(EPOCH FROM (NOW() - pls.started_at))::INTEGER)
          END AS duration_seconds,
          (pls.ended_at IS NULL) AS is_live,
          DATE(pls.started_at AT TIME ZONE 'Asia/Jakarta') AS tanggal
        FROM party_live_sessions pls
        WHERE LOWER(pls.username) IN (
          SELECT LOWER(ah.username)
          FROM agency_hosts ah
          WHERE ah.agency_id = ${agencyId} AND ah.status = 'active'
          UNION
          SELECT LOWER(${user.username})
        )
          AND pls.started_at >= NOW() - (${days} * INTERVAL '1 day')
        ORDER BY pls.started_at DESC
        LIMIT 1000
      `);

      const sessions = rows.rows as any[];

      // Buat ringkasan per tanggal per host (untuk tampilan di dashboard)
      const byDateMap: Record<string, {
        tanggal: string;
        hosts: Record<string, { username: string; total_seconds: number; sessions: any[] }>;
      }> = {};

      for (const s of sessions) {
        const tgl = String(s.tanggal);
        if (!byDateMap[tgl]) byDateMap[tgl] = { tanggal: tgl, hosts: {} };
        const uname = s.username;
        if (!byDateMap[tgl].hosts[uname]) {
          byDateMap[tgl].hosts[uname] = { username: uname, total_seconds: 0, sessions: [] };
        }
        const dur = Number(s.duration_seconds ?? 0);
        byDateMap[tgl].hosts[uname].total_seconds += dur;
        byDateMap[tgl].hosts[uname].sessions.push({
          id: s.id,
          room_name: s.room_name,
          started_at: s.started_at,
          ended_at: s.ended_at,
          duration_seconds: dur,
          is_live: s.is_live,
        });
      }

      // Ubah map ke array diurut dari terbaru
      const byDate = Object.values(byDateMap)
        .sort((a, b) => b.tanggal.localeCompare(a.tanggal))
        .map(d => ({
          tanggal: d.tanggal,
          hosts: Object.values(d.hosts).sort((a, b) => b.total_seconds - a.total_seconds),
        }));

      return res.json({ sessions, byDate });
    } catch (e: any) {
      console.error("[agency/my/live-sessions]", e?.message);
      return res.status(500).json({ message: e?.message ?? "Server error" });
    }
  });

  // ── GET /api/agency/my/live-daily ─────────────────────────────────────────
  // Data Live harian untuk profil host: tanggal | jam live | coin pendapatan | nama agency
  // Hanya untuk user yang sedang login dan terdaftar sebagai host di agency manapun.
  app.get("/api/agency/my/live-daily", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ message: "Not logged in" });
    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) return res.status(401).json({ message: "User not found" });

      // Cari agency tempat user terdaftar sebagai host aktif (atau owner)
      const hostRes = await db.execute(sql`
        SELECT a.agency_name
        FROM agency_hosts ah
        JOIN agencies a ON a.id = ah.agency_id
        WHERE LOWER(ah.username) = LOWER(${user.username})
          AND ah.status = 'active'
        LIMIT 1
      `);
      // Fallback: cek apakah user adalah owner agency
      let agencyName: string | null = null;
      if (hostRes.rows.length > 0) {
        agencyName = (hostRes.rows[0] as any).agency_name ?? null;
      } else {
        const ownerRes = await db.execute(sql`
          SELECT agency_name FROM agencies
          WHERE LOWER(registered_by) = LOWER(${user.username}) AND status = 'approved'
          LIMIT 1
        `);
        if (ownerRes.rows.length > 0) {
          agencyName = (ownerRes.rows[0] as any).agency_name ?? null;
        }
      }

      if (!agencyName) {
        return res.json({ daily: [], agencyName: null });
      }

      // Ambil 30 hari terakhir sesi live milik user ini (langsung dari username)
      // Digroup per hari (WIB = UTC+7)
      const sessRes = await db.execute(sql`
        SELECT
          TO_CHAR(pls.started_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS tanggal,
          COALESCE(SUM(
            CASE
              WHEN pls.ended_at IS NOT NULL THEN pls.duration_seconds
              ELSE GREATEST(0, EXTRACT(EPOCH FROM (NOW() - pls.started_at))::INTEGER)
            END
          ), 0)::BIGINT AS total_seconds
        FROM party_live_sessions pls
        WHERE LOWER(pls.username) = LOWER(${user.username})
          AND pls.started_at >= NOW() - INTERVAL '30 days'
        GROUP BY tanggal
      `);

      // Coin pendapatan harian dari party_income_log (room milik user)
      const coinRes = await db.execute(sql`
        SELECT
          TO_CHAR(pil.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS tanggal,
          COALESCE(SUM(pil.coin_amount), 0)::BIGINT AS total_coin
        FROM party_income_log pil
        LEFT JOIN party_rooms pr ON pr.id = pil.room_id
        WHERE LOWER(COALESCE(pr.creator_username, '')) = LOWER(${user.username})
          AND pil.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY tanggal
      `);

      // Gabungkan session + coin per tanggal
      const coinMap: Record<string, number> = {};
      for (const r of coinRes.rows as any[]) {
        coinMap[r.tanggal] = Number(r.total_coin ?? 0);
      }

      // Kumpulkan semua tanggal unik dari kedua query
      const allDates = new Set<string>();
      for (const r of sessRes.rows as any[]) allDates.add(r.tanggal);
      for (const d of Object.keys(coinMap)) allDates.add(d);

      const sessMap: Record<string, number> = {};
      for (const r of sessRes.rows as any[]) {
        sessMap[r.tanggal] = Number(r.total_seconds ?? 0);
      }

      const daily = Array.from(allDates)
        .map(tanggal => ({
          tanggal,
          live_seconds: sessMap[tanggal] ?? 0,
          coin:         coinMap[tanggal] ?? 0,
          agency_name:  agencyName,
        }))
        .sort((a, b) => b.tanggal.localeCompare(a.tanggal));

      return res.json({ daily, agencyName });
    } catch (e: any) {
      console.error("[agency/my/live-daily]", e?.message);
      return res.status(500).json({ message: e?.message ?? "Server error" });
    }
  });
}
