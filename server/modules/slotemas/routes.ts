import type { Express, Request } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";
import { verifyJwt } from "../../middleware/jwtAuth";
import { broadcastToAllClients } from "../../gateway";

// ─── Slot Emas ─────────────────────────────────────────────────────────────────
//
// GET  /api/games/slotemas/balance      — coin balance
// POST /api/games/slotemas/spin         — spin (body: { bet, roomId? })
// GET  /api/games/slotemas/history      — personal history
// GET  /api/games/slotemas/top-winners  — leaderboard (24h)

// Symbol index must match frontend S[] array
const SYMBOLS = [
  { name: "Tujuh",   triple_mult: 100, pair_mult: 5,  weight: 8   }, // 0 — jackpot
  { name: "Berlian", triple_mult: 50,  pair_mult: 3,  weight: 12  }, // 1
  { name: "Mahkota", triple_mult: 25,  pair_mult: 2,  weight: 18  }, // 2
  { name: "Bintang", triple_mult: 15,  pair_mult: 2,  weight: 35  }, // 3
  { name: "Bel",     triple_mult: 10,  pair_mult: 2,  weight: 55  }, // 4
  { name: "Ceri",    triple_mult: 8,   pair_mult: 2,  weight: 75  }, // 5
  { name: "Lemon",   triple_mult: 5,   pair_mult: 2,  weight: 85  }, // 6
  { name: "Koin",    triple_mult: 3,   pair_mult: 2,  weight: 100 }, // 7 — most common
];
const TOTAL_W = SYMBOLS.reduce((s, x) => s + x.weight, 0);
const HOUSE   = 0.05; // 5% house cut on winnings

function pickSym(): number {
  let r = Math.random() * TOTAL_W;
  for (let i = 0; i < SYMBOLS.length; i++) {
    r -= SYMBOLS[i].weight;
    if (r <= 0) return i;
  }
  return SYMBOLS.length - 1;
}

interface WinResult {
  multiplier: number;
  comboName: string;
  isJackpot: boolean;
  winAmount: number;
}

function calcWin(reels: number[], bet: number): WinResult {
  const [a, b, c] = reels;

  // Triple
  if (a === b && b === c) {
    const mult = SYMBOLS[a].triple_mult;
    return {
      multiplier: mult,
      comboName:  `${SYMBOLS[a].name} × 3`,
      isJackpot:  a === 0,
      winAmount:  Math.floor(bet * mult * (1 - HOUSE)),
    };
  }

  // Check pairs for ALL symbols — highest-value pair wins
  let bestPair: WinResult | null = null;
  for (let si = 0; si < SYMBOLS.length; si++) {
    const pm = SYMBOLS[si].pair_mult;
    if (pm === 0) continue;
    const count = reels.filter(x => x === si).length;
    if (count >= 2) {
      const candidate: WinResult = {
        multiplier: pm,
        comboName:  `2× ${SYMBOLS[si].name}`,
        isJackpot:  false,
        winAmount:  Math.floor(bet * pm * (1 - HOUSE)),
      };
      if (!bestPair || pm > bestPair.multiplier) bestPair = candidate;
    }
  }
  if (bestPair) return bestPair;

  return { multiplier: 0, comboName: "Tidak menang", isJackpot: false, winAmount: 0 };
}

function getToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return (req.query.token as string | undefined) ?? null;
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS slotemas_spins (
      id            SERIAL PRIMARY KEY,
      user_id       TEXT NOT NULL,
      username      TEXT NOT NULL,
      bet           BIGINT NOT NULL,
      reel0         INT NOT NULL,
      reel1         INT NOT NULL,
      reel2         INT NOT NULL,
      multiplier    INT NOT NULL,
      combo_name    TEXT NOT NULL,
      win_amount    BIGINT NOT NULL,
      net           BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      is_jackpot    BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  tableReady = true;
}

export function registerSlotEmasRoutes(app: Express) {

  // ── GET /api/games/slotemas/balance ────────────────────────────────────────
  app.get("/api/games/slotemas/balance", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });
    try {
      const user = await storage.getUser(payload.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const acct = await storage.getCreditAccount(user.username);
      res.json({ balance: acct.balance, username: user.username });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── POST /api/games/slotemas/spin ──────────────────────────────────────────
  // Body: { bet: number, roomId?: string }
  app.post("/api/games/slotemas/spin", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    const bet = Number(req.body.bet);
    if (!bet || bet <= 0 || !Number.isInteger(bet)) {
      return res.status(400).json({ error: "Bet tidak valid" });
    }

    try {
      await ensureTable();
      const user = await storage.getUser(payload.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const acct = await storage.getCreditAccount(user.username);
      if (acct.balance < bet) {
        return res.status(402).json({ error: "Koin tidak cukup" });
      }

      // Deduct bet
      await storage.adjustBalance(user.username, -bet);

      // Server picks all 3 reels independently
      const reels = [pickSym(), pickSym(), pickSym()];
      const { multiplier, comboName, isJackpot, winAmount } = calcWin(reels, bet);
      const net = winAmount - bet;

      // Credit winnings
      const finalAcct = await storage.adjustBalance(user.username, winAmount);

      // Record
      await db.execute(sql`
        INSERT INTO slotemas_spins
          (user_id, username, bet, reel0, reel1, reel2, multiplier, combo_name,
           win_amount, net, balance_after, is_jackpot)
        VALUES
          (${payload.userId}, ${user.username}, ${bet},
           ${reels[0]}, ${reels[1]}, ${reels[2]},
           ${multiplier}, ${comboName}, ${winAmount}, ${net},
           ${finalAcct.balance}, ${isJackpot})
      `);

      // Broadcast big win (≥ 50,000) globally to all party rooms
      if (winAmount >= 50_000) {
        try {
          const sym = SYMBOLS[reels[0]] ?? SYMBOLS[7];
          broadcastToAllClients({
            type: "GAME_WIN",
            eventId: `gw-${user.username}-${Date.now()}`,
            username: user.username,
            gameName: "Slot Emas",
            gameEmoji: "🎰",
            amount: winAmount,
            slotEmoji: isJackpot ? "💰" : "⭐",
            multiplier,
            isGlobal: true,
          });
        } catch {
          // non-critical
        }
      }

      res.json({
        reels,
        multiplier,
        comboName,
        isJackpot,
        winAmount,
        net,
        newBalance: finalAcct.balance,
      });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/slotemas/history ───────────────────────────────────────
  app.get("/api/games/slotemas/history", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });
    try {
      await ensureTable();
      const rows = await db.execute(sql`
        SELECT bet, reel0, reel1, reel2, combo_name, win_amount, net, created_at
        FROM slotemas_spins
        WHERE user_id = ${payload.userId}
        ORDER BY created_at DESC
        LIMIT 30
      `);
      res.json({ history: rows.rows });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/slotemas/top-winners ───────────────────────────────────
  app.get("/api/games/slotemas/top-winners", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });
    try {
      await ensureTable();
      const rows = await db.execute(sql`
        SELECT username,
               SUM(win_amount)  AS total_win,
               MAX(reel1)       AS last_mid_reel
        FROM slotemas_spins
        WHERE net > 0 AND created_at > NOW() - INTERVAL '24 hours'
        GROUP BY username
        ORDER BY total_win DESC
        LIMIT 10
      `);
      const stats = await db.execute(sql`
        SELECT COALESCE(SUM(win_amount), 0) AS total_paid_out,
               COUNT(*) AS total_wins
        FROM slotemas_spins
        WHERE net > 0 AND created_at > NOW() - INTERVAL '24 hours'
      `);
      const s = stats.rows[0] as any;
      res.json({
        winners: rows.rows.map((r: any, i: number) => ({
          rank:     i + 1,
          username: r.username,
          amount:   Number(r.total_win),
        })),
        totalPaidOut: Number(s?.total_paid_out ?? 0),
        totalWins:    Number(s?.total_wins ?? 0),
      });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });
}
