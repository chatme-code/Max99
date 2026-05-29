import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";

export function registerPublicRoutes(app: Express) {
  app.get("/api/public/releases", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, version_name, version_code, changelog,
               file_name, file_size, download_url, min_android,
               download_count, created_at
        FROM apk_releases
        WHERE is_active = true
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const release = result.rows[0] ?? null;
      res.json({ release });
    } catch (err) {
      console.error("[public/releases] error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/public/version-check", async (req: Request, res: Response) => {
    try {
      const currentCodeRaw = req.query.currentCode ?? req.query.current_code;
      const currentCode = parseInt(String(currentCodeRaw ?? ""), 10);

      const result = await db.execute(sql`
        SELECT id, version_name, version_code, changelog,
               file_name, file_size, download_url, min_android,
               download_count, force_update, store_url, created_at
        FROM apk_releases
        WHERE is_active = true
        ORDER BY version_code DESC, created_at DESC
        LIMIT 1
      `);
      const latest = result.rows[0] ?? null;

      if (!latest) {
        return res.json({ updateAvailable: false, latest: null });
      }

      const updateAvailable = Number.isFinite(currentCode)
        ? Number(latest.version_code) > currentCode
        : true;

      res.json({
        updateAvailable,
        currentCode: Number.isFinite(currentCode) ? currentCode : null,
        forceUpdate: updateAvailable && Boolean(latest.force_update),
        latest,
      });
    } catch (err) {
      console.error("[public/version-check] error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/public/releases/all", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, version_name, version_code, changelog,
               file_name, file_size, download_url, min_android,
               download_count, created_at
        FROM apk_releases
        ORDER BY created_at DESC
        LIMIT 20
      `);
      res.json({ releases: result.rows });
    } catch (err) {
      console.error("[public/releases/all] error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/public/releases/:id/track", async (req: Request, res: Response) => {
    try {
      const releaseId = parseInt(req.params.id);
      if (isNaN(releaseId)) return res.status(400).json({ ok: false });

      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
        || req.socket?.remoteAddress
        || null;
      const ua = req.headers["user-agent"] || null;

      await db.execute(sql`
        UPDATE apk_releases SET download_count = download_count + 1
        WHERE id = ${releaseId}
      `);
      await db.execute(sql`
        INSERT INTO apk_download_logs (release_id, ip, user_agent)
        VALUES (${releaseId}, ${ip}, ${ua})
      `);

      res.json({ ok: true });
    } catch (err) {
      console.error("[public/track] error:", err);
      res.status(500).json({ ok: false });
    }
  });

  app.get("/api/public/stats", async (_req, res) => {
    try {
      const [totalUsersRes, totalDownloadsRes, userGrowthRes, dlTrendRes] = await Promise.all([
        db.execute(sql`SELECT COUNT(*) AS total FROM users`),
        db.execute(sql`SELECT COALESCE(SUM(download_count),0) AS total FROM apk_releases`),
        db.execute(sql`
          SELECT
            TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
            COUNT(*) AS new_users
          FROM users
          WHERE created_at >= NOW() - INTERVAL '12 months'
          GROUP BY 1
          ORDER BY 1
        `),
        db.execute(sql`
          SELECT
            TO_CHAR(DATE_TRUNC('day', logged_at), 'YYYY-MM-DD') AS day,
            COUNT(*) AS downloads
          FROM apk_download_logs
          WHERE logged_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1
          ORDER BY 1
        `),
      ]);

      res.json({
        total_users:     Number((totalUsersRes.rows[0] as any)?.total ?? 0),
        total_downloads: Number((totalDownloadsRes.rows[0] as any)?.total ?? 0),
        user_growth:     userGrowthRes.rows,
        dl_trend:        dlTrendRes.rows,
      });
    } catch (err) {
      console.error("[public/stats] error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
