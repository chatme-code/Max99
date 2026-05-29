import { type Express } from 'express';
import { db } from '../../db';
import { sql } from 'drizzle-orm';

let initialized = false;
async function ensureTable() {
  if (initialized) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS home_banners (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '',
      image_url   TEXT NOT NULL,
      link_url    TEXT NOT NULL DEFAULT '',
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  initialized = true;
}

export function registerBannerRoutes(app: Express) {
  app.get('/api/banners', async (_req, res) => {
    try {
      await ensureTable();
      const result = await db.execute(sql`
        SELECT id, title, image_url, link_url, sort_order
        FROM home_banners
        WHERE is_active = TRUE
        ORDER BY sort_order ASC, created_at ASC
      `);
      res.json({ banners: result.rows });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to load banners' });
    }
  });
}
