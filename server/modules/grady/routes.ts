import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";
import { verifyJwt } from "../../middleware/jwtAuth";
import { broadcastToRoom, broadcastToAllClients } from "../../gateway";
import path from "path";

// ─── Grady Game Hub ───────────────────────────────────────────────────────────
//
// GET  /games/grady                         — hub page
// GET  /games/grady/ferriswheel             — ferris wheel game page
// GET  /api/games/grady/balance             — get user coin balance
// POST /api/games/grady/spin                — spin ferris wheel (bets[] per gondola)
// GET  /api/games/grady/history             — spin history (current user)
// GET  /api/games/grady/top-winners         — recent big winners (all users)

// 8 gondola slots — index matches frontend SLOTS array
// Weights designed so each slot has ~7% house edge:
//   EV(x5)  = (190/954)*5  ≈ 0.996
//   EV(x10) = (90/954)*10  ≈ 0.943
//   EV(x15) = (60/954)*15  ≈ 0.943
//   EV(x25) = (36/954)*25  ≈ 0.943
//   EV(x45) = (8/954)*45   ≈ 0.377  ← very rare, protects app revenue
const SLOTS = [
  { emoji: "🐔", name: "Ayam",   multiplier: 45, weight: 8   }, // 0 — very rare jackpot
  { emoji: "🍅", name: "Tomat",  multiplier: 5,  weight: 190 }, // 1 — common
  { emoji: "🐄", name: "Sapi",   multiplier: 15, weight: 60  }, // 2 — uncommon
  { emoji: "🥬", name: "Sayur",  multiplier: 5,  weight: 190 }, // 3 — common
  { emoji: "🐟", name: "Ikan",   multiplier: 25, weight: 36  }, // 4 — rare
  { emoji: "🥕", name: "Wortel", multiplier: 5,  weight: 190 }, // 5 — common
  { emoji: "🦐", name: "Udang",  multiplier: 10, weight: 90  }, // 6 — uncommon
  { emoji: "🌽", name: "Jagung", multiplier: 5,  weight: 190 }, // 7 — common
];
const TOTAL_WEIGHT = SLOTS.reduce((s, sl) => s + sl.weight, 0); // 966

// House cut: 3% on winnings so app is sustainable
const HOUSE_CUT = 0.03;

function pickSlot(): number {
  let r = Math.random() * TOTAL_WEIGHT;
  for (let i = 0; i < SLOTS.length; i++) {
    r -= SLOTS[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}

function getToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const q = req.query.token as string | undefined;
  return q ?? null;
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS grady_spins (
      id            SERIAL PRIMARY KEY,
      user_id       TEXT NOT NULL,
      username      TEXT NOT NULL,
      round_id      BIGINT,
      bet           BIGINT NOT NULL,
      slot_index    INT NOT NULL,
      slot_name     TEXT NOT NULL,
      multiplier    INT NOT NULL,
      win_amount    BIGINT NOT NULL,
      net           BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  tableReady = true;
}

export function registerGradyRoutes(app: Express) {
  const PUBLIC = path.join(process.cwd(), "server/public/grady");

  // ── Serve Hub HTML ───────────────────────────────────────────────────────
  app.get("/games/grady", (_req, res) => {
    res.sendFile(path.join(PUBLIC, "index.html"));
  });

  // ── Serve Game HTML pages ────────────────────────────────────────────────
  app.get("/games/grady/lavaslot", (_req, res) => {
    res.sendFile(path.join(PUBLIC, "lavaslot/index.html"));
  });

  app.get("/games/grady/ferriswheel", (_req, res) => {
    res.sendFile(path.join(PUBLIC, "ferriswheel/index.html"));
  });

  app.get("/games/grady/teenpatti", (_req, res) => {
    res.sendFile(path.join(PUBLIC, "teenpatti/index.html"));
  });

  // ── Static assets for teenpatti (bg images, SVGs) ────────────────────────
  app.get("/games/grady/teenpatti/:file", (req, res) => {
    res.sendFile(path.join(PUBLIC, "teenpatti", req.params.file));
  });

  // ── GET /api/games/grady/balance ─────────────────────────────────────────
  app.get("/api/games/grady/balance", async (req, res) => {
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

  // ── POST /api/games/grady/spin ───────────────────────────────────────────
  // Body: { bets: number[8], roundId?: number }
  // bets[i] = coin amount bet on gondola i (0 if not betting on it)
  app.post("/api/games/grady/spin", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    // Accept both legacy { bet } and new { bets[] }
    let betsArr: number[];
    if (Array.isArray(req.body.bets)) {
      betsArr = req.body.bets.map(Number);
      if (betsArr.length !== SLOTS.length || betsArr.some(b => b < 0 || !Number.isInteger(b))) {
        return res.status(400).json({ error: "bets array tidak valid" });
      }
    } else {
      // Legacy single-bet mode: spread evenly across all slots
      const singleBet = Number(req.body.bet);
      if (!singleBet || singleBet <= 0) return res.status(400).json({ error: "Bet tidak valid" });
      betsArr = new Array(SLOTS.length).fill(0);
      betsArr[0] = singleBet;
    }

    const totalBet = betsArr.reduce((a, b) => a + b, 0);
    if (totalBet <= 0) return res.status(400).json({ error: "Total taruhan 0" });

    const roundId = Number(req.body.roundId) || Date.now();

    try {
      await ensureTable();
      const user = await storage.getUser(payload.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const acct = await storage.getCreditAccount(user.username);
      if (acct.balance < totalBet) {
        return res.status(402).json({ error: "Koin tidak cukup" });
      }

      // Deduct total bet
      await storage.adjustBalance(user.username, -totalBet);

      // Server picks winning slot (client animation follows)
      const slotIdx = pickSlot();
      const slot = SLOTS[slotIdx];
      const betOnWinner = betsArr[slotIdx];

      // Win = bet on winning gondola × multiplier × (1 - house cut)
      const winAmount = Math.floor(betOnWinner * slot.multiplier * (1 - HOUSE_CUT));
      const net = winAmount - totalBet;

      // Add winnings
      const finalAcct = await storage.adjustBalance(user.username, winAmount);

      // Record
      await db.execute(sql`
        INSERT INTO grady_spins
          (user_id, username, round_id, bet, slot_index, slot_name, multiplier, win_amount, net, balance_after)
        VALUES
          (${payload.userId}, ${user.username}, ${roundId}, ${totalBet},
           ${slotIdx}, ${slot.name}, ${slot.multiplier}, ${winAmount}, ${net}, ${finalAcct.balance})
      `);

      // Top 3 winners in this round (all users, same round_id, positive net)
      const topRows = await db.execute(sql`
        SELECT username, win_amount, slot_index, slot_name
        FROM grady_spins
        WHERE round_id = ${roundId} AND net > 0
        ORDER BY win_amount DESC
        LIMIT 3
      `);

      // Also fetch recent global top winners if current round has no other players
      const recentRows = await db.execute(sql`
        SELECT username, win_amount, slot_index, slot_name
        FROM grady_spins
        WHERE net > 0
        ORDER BY created_at DESC, win_amount DESC
        LIMIT 5
      `);

      const topWinners = topRows.rows.length >= 1 ? topRows.rows : recentRows.rows.slice(0, 3);

      // Broadcast big win (≥ 50,000) globally to all party rooms
      if (winAmount >= 50_000) {
        try {
          const partyRoomId = (req.body.roomId as string | undefined)?.trim();
          broadcastToAllClients({
            type: "GAME_WIN",
            eventId: `gw-${user.username}-${Date.now()}`,
            roomId: partyRoomId,
            username: user.username,
            gameName: "Kincir Angin",
            gameEmoji: "🎡",
            amount: winAmount,
            slotEmoji: slot.emoji,
            multiplier: slot.multiplier,
            isGlobal: true,
          });
        } catch {
          // Non-critical
        }
      }

      res.json({
        slotIndex: slotIdx,
        slotEmoji: slot.emoji,
        slotName: slot.name,
        multiplier: slot.multiplier,
        betOnWinner,
        totalBet,
        winAmount,
        net,
        newBalance: finalAcct.balance,
        houseCutPct: Math.round(HOUSE_CUT * 100),
        topWinners: topWinners.map((r: any) => ({
          username: r.username,
          amount: Number(r.win_amount),
          slotIndex: r.slot_index,
          slotName: r.slot_name,
          emoji: SLOTS[r.slot_index]?.emoji ?? "🎰",
        })),
      });
    } catch (e: any) {
      console.error("[Grady] spin error:", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/grady/history ─────────────────────────────────────────
  app.get("/api/games/grady/history", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });
    try {
      await ensureTable();
      const rows = await db.execute(sql`
        SELECT slot_name, slot_index, multiplier, bet, win_amount, net, balance_after, created_at
        FROM grady_spins
        WHERE user_id = ${payload.userId}
        ORDER BY created_at DESC
        LIMIT 20
      `);
      res.json({ history: rows.rows });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/grady/top-winners ─────────────────────────────────────
  app.get("/api/games/grady/top-winners", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });
    try {
      await ensureTable();
      // Top winners: aggregate per user, 24h
      const rows = await db.execute(sql`
        SELECT username,
               SUM(win_amount)  AS total_win,
               MAX(slot_index)  AS last_slot
        FROM grady_spins
        WHERE net > 0 AND created_at > NOW() - INTERVAL '24 hours'
        GROUP BY username
        ORDER BY total_win DESC
        LIMIT 10
      `);
      // Total coins paid out in 24h
      const statsRow = await db.execute(sql`
        SELECT COALESCE(SUM(win_amount), 0) AS total_paid_out,
               COUNT(*) AS total_spins
        FROM grady_spins
        WHERE net > 0 AND created_at > NOW() - INTERVAL '24 hours'
      `);
      const stats = statsRow.rows[0] as any;
      res.json({
        winners: rows.rows.map((r: any, idx: number) => ({
          rank: idx + 1,
          username: r.username,
          amount: Number(r.total_win),
          emoji: SLOTS[Number(r.last_slot)]?.emoji ?? "🎰",
        })),
        totalPaidOut: Number(stats?.total_paid_out ?? 0),
        totalSpins: Number(stats?.total_spins ?? 0),
      });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // LAVA SLOT
  // POST /api/games/lavaslot/spin
  // ══════════════════════════════════════════════════════════════════════════

  const LAVA_SYMS = [
    { id: "wild",   name: "Wild",    weight: 2,  m3: 100, m5: 500 },
    { id: "toucan", name: "Toucan",  weight: 8,  m3: 15,  m5: 80  },
    { id: "flower", name: "Flower",  weight: 15, m3: 8,   m5: 40  },
    { id: "turtle", name: "Turtle",  weight: 20, m3: 5,   m5: 25  },
    { id: "tiki",   name: "Tiki",    weight: 25, m3: 4,   m5: 18  },
    { id: "a",      name: "Huruf A", weight: 35, m3: 3,   m5: 12  },
    { id: "k",      name: "Huruf K", weight: 45, m3: 2,   m5: 8   },
    { id: "fire",   name: "Api",     weight: 50, m3: 1,   m5: 4   },
  ];
  const LAVA_TOTAL_W = LAVA_SYMS.reduce((s, x) => s + x.weight, 0);

  function pickLavaSym(): number {
    let r = Math.random() * LAVA_TOTAL_W;
    for (let i = 0; i < LAVA_SYMS.length; i++) {
      r -= LAVA_SYMS[i].weight;
      if (r <= 0) return i;
    }
    return LAVA_SYMS.length - 1;
  }

  let lavaTableReady = false;
  async function ensureLavaTable() {
    if (lavaTableReady) return;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lava_slot_spins (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL,
        username      TEXT NOT NULL,
        bet           BIGINT NOT NULL,
        mid_row       JSONB NOT NULL,
        win_count     INT NOT NULL DEFAULT 0,
        multiplier    INT NOT NULL DEFAULT 0,
        win_amount    BIGINT NOT NULL DEFAULT 0,
        net           BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    lavaTableReady = true;
  }

  app.post("/api/games/lavaslot/spin", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    const bet = Number(req.body.bet);
    if (!bet || bet <= 0 || !Number.isInteger(bet)) {
      return res.status(400).json({ error: "Bet tidak valid" });
    }

    try {
      await ensureLavaTable();
      const user = await storage.getUser(payload.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const acct = await storage.getCreditAccount(user.username);
      if (acct.balance < bet) {
        return res.status(402).json({ error: "Koin tidak cukup" });
      }

      await storage.adjustBalance(user.username, -bet);

      // Generate 5 reels × 3 rows — middle row (index 1) is the win line
      const grid: number[][] = Array.from({ length: 5 }, () =>
        Array.from({ length: 3 }, () => pickLavaSym())
      );
      const midRow = grid.map((reel) => reel[1]);

      // Count consecutive matching symbols from left on middle row
      // Wild (idx 0) counts as any symbol
      let winCount = 0;
      let winSym = -1;
      for (let c = 0; c < 5; c++) {
        const s = midRow[c];
        if (c === 0) {
          winSym = s === 0 ? -1 : s; // defer wild resolution
          winCount = 1;
        } else {
          const match = s === winSym || s === 0 || winSym === -1;
          if (match) {
            if (winSym === -1 && s !== 0) winSym = s;
            winCount++;
          } else {
            break;
          }
        }
      }
      if (winSym === -1) winSym = 0; // all wilds

      let multiplier = 0;
      let winAmount = 0;
      if (winCount >= 3) {
        const sym = LAVA_SYMS[winSym] ?? LAVA_SYMS[0];
        multiplier = winCount >= 5 ? sym.m5 : (winCount === 4 ? Math.floor((sym.m3 + sym.m5) / 2) : sym.m3);
        winAmount = Math.floor(bet * multiplier * 0.97); // 3% house cut
      }

      const net = winAmount - bet;
      const finalAcct = await storage.adjustBalance(user.username, winAmount);

      await db.execute(sql`
        INSERT INTO lava_slot_spins
          (user_id, username, bet, mid_row, win_count, multiplier, win_amount, net, balance_after)
        VALUES
          (${payload.userId}, ${user.username}, ${bet},
           ${JSON.stringify(midRow)}::jsonb,
           ${winCount >= 3 ? winCount : 0}, ${multiplier}, ${winAmount}, ${net}, ${finalAcct.balance})
      `);

      // Broadcast big win (≥ 50,000) globally to all party rooms
      if (winAmount >= 50_000) {
        try {
          const partyRoomId = (req.body.roomId as string | undefined)?.trim();
          broadcastToAllClients({
            type: "GAME_WIN",
            eventId: `gw-${user.username}-${Date.now()}`,
            roomId: partyRoomId,
            username: user.username,
            gameName: "Lava Slot",
            gameEmoji: "🌋",
            amount: winAmount,
            slotEmoji: LAVA_SYMS[winSym]?.id === "wild" ? "💎" : "🌋",
            multiplier,
            isGlobal: true,
          });
        } catch {
          // non-critical
        }
      }

      res.json({
        midRow,
        winCount: winCount >= 3 ? winCount : 0,
        multiplier,
        winAmount,
        net,
        newBalance: finalAcct.balance,
      });
    } catch (e: any) {
      console.error("[LavaSlot] spin error:", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ── TEEN PATTI ─────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  let tpTableReady = false;
  async function ensureTpTable() {
    if (tpTableReady) return;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS teenpatti_games (
        id           SERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        username     TEXT NOT NULL,
        bet_a        BIGINT NOT NULL DEFAULT 0,
        bet_b        BIGINT NOT NULL DEFAULT 0,
        bet_c        BIGINT NOT NULL DEFAULT 0,
        total_bet    BIGINT NOT NULL,
        winner       TEXT NOT NULL,
        winner_hand  TEXT NOT NULL,
        win_amount   BIGINT NOT NULL DEFAULT 0,
        net          BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    tpTableReady = true;
  }

  // ── Card engine ────────────────────────────────────────────────────────────
  type Suit = 'S' | 'H' | 'D' | 'C';
  interface TPCard { suit: Suit; rank: number; }
  interface HandResult { rank: number; name: string; tb: number[]; }

  function makeDeck(): TPCard[] {
    const suits: Suit[] = ['S','H','D','C'];
    const deck: TPCard[] = [];
    for (const suit of suits) for (let r = 2; r <= 14; r++) deck.push({ suit, rank: r });
    return deck;
  }
  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function isSequence(ranks: number[]): boolean {
    const s = [...ranks].sort((a, b) => a - b);
    // Normal consecutive
    if (s[2] - s[1] === 1 && s[1] - s[0] === 1) return true;
    // A-2-3 special case
    if (s[0] === 2 && s[1] === 3 && s[2] === 14) return true;
    // A-K-Q
    if (s[0] === 12 && s[1] === 13 && s[2] === 14) return true;
    return false;
  }

  function seqHigh(ranks: number[]): number {
    const s = [...ranks].sort((a, b) => a - b);
    if (s[0] === 2 && s[1] === 3 && s[2] === 14) return 3; // A-2-3 lowest
    return s[2];
  }

  function evaluateHand(cards: TPCard[]): HandResult {
    const ranks = cards.map(c => c.rank);
    const suits = cards.map(c => c.suit);
    const sorted = [...ranks].sort((a, b) => b - a);

    const allSameSuit = suits[0] === suits[1] && suits[1] === suits[2];
    const seq         = isSequence(ranks);
    const rankCounts  = ranks.reduce<Record<number,number>>((acc, r) => { acc[r] = (acc[r]||0)+1; return acc; }, {});
    const counts      = Object.values(rankCounts).sort((a,b) => b - a);
    const highRanks   = Object.entries(rankCounts).sort((a,b) => Number(b[0])-Number(a[0])).map(e => Number(e[0]));

    // Trail
    if (counts[0] === 3) return { rank: 6, name: 'Trail', tb: [sorted[0]] };
    // Pure Sequence
    if (allSameSuit && seq) return { rank: 5, name: 'Pure Sequence', tb: [seqHigh(ranks)] };
    // Sequence
    if (seq) return { rank: 4, name: 'Sequence', tb: [seqHigh(ranks)] };
    // Color (Flush)
    if (allSameSuit) return { rank: 3, name: 'Color', tb: sorted };
    // Pair
    if (counts[0] === 2) {
      const pairRank = Number(Object.entries(rankCounts).find(([,v]) => v === 2)![0]);
      const kicker   = Number(Object.entries(rankCounts).find(([,v]) => v === 1)![0]);
      return { rank: 2, name: 'Pair', tb: [pairRank, kicker] };
    }
    // High Card
    return { rank: 1, name: 'High Card', tb: sorted };
  }

  function compareHands(a: HandResult, b: HandResult): number {
    if (a.rank !== b.rank) return a.rank - b.rank;
    for (let i = 0; i < Math.max(a.tb.length, b.tb.length); i++) {
      const diff = (a.tb[i] || 0) - (b.tb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  // Multiplier per kursi: A=×2, B=×2.5, C=×2
  const TP_SEAT_MULT: Record<'A'|'B'|'C', number> = { A: 2.0, B: 2.5, C: 2.0 };
  const TP_HOUSE_CUT  = 0.03;

  // ── POST /api/games/teenpatti/deal ─────────────────────────────────────────
  app.post("/api/games/teenpatti/deal", async (req: Request, res: Response) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    try {
      await ensureTpTable();
      const user = await storage.getUser(payload.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const betA = Math.max(0, Math.floor(Number(req.body.betA) || 0));
      const betB = Math.max(0, Math.floor(Number(req.body.betB) || 0));
      const betC = Math.max(0, Math.floor(Number(req.body.betC) || 0));
      const totalBet = betA + betB + betC;

      if (totalBet <= 0) return res.status(400).json({ error: "Pasang taruhan dulu" });

      const acct = await storage.getCreditAccount(user.username);
      if (acct.balance < totalBet) return res.status(400).json({ error: "Saldo tidak cukup" });

      // Deal cards
      const deck = shuffle(makeDeck());
      const handA = deck.slice(0, 3);
      const handB = deck.slice(3, 6);
      const handC = deck.slice(6, 9);

      const evalA = evaluateHand(handA);
      const evalB = evaluateHand(handB);
      const evalC = evaluateHand(handC);

      // Find winner
      const evals = { A: evalA, B: evalB, C: evalC };
      let winner: 'A'|'B'|'C' = 'A';
      if (compareHands(evalB, evals[winner]) > 0) winner = 'B';
      if (compareHands(evalC, evals[winner]) > 0) winner = 'C';

      // Payouts — per-seat multiplier: A=×2, B=×2.5, C=×2
      const betOnWinner = winner === 'A' ? betA : winner === 'B' ? betB : betC;
      const winAmount   = Math.floor(betOnWinner * TP_SEAT_MULT[winner] * (1 - TP_HOUSE_CUT));
      const net         = winAmount - totalBet;

      // Adjust balance: deduct all bets, credit winnings
      const afterDeduct = await storage.adjustBalance(user.username, -totalBet);
      let finalBalance  = afterDeduct.balance;
      if (winAmount > 0) {
        const afterWin = await storage.adjustBalance(user.username, winAmount);
        finalBalance = afterWin.balance;
      }

      // Persist
      await db.execute(sql`
        INSERT INTO teenpatti_games
          (user_id, username, bet_a, bet_b, bet_c, total_bet, winner, winner_hand, win_amount, net, balance_after)
        VALUES
          (${payload.userId}, ${user.username}, ${betA}, ${betB}, ${betC},
           ${totalBet}, ${winner}, ${evals[winner].name}, ${winAmount}, ${net}, ${finalBalance})
      `);

      // Broadcast big win
      if (winAmount >= 50_000) {
        try {
          broadcastToAllClients({
            type: "GAME_WIN",
            eventId: `gw-${user.username}-${Date.now()}`,
            roomId: (req.body.roomId as string | undefined)?.trim(),
            username: user.username,
            gameName: "Teen Patti",
            gameEmoji: "🃏",
            amount: winAmount,
            slotEmoji: "🏆",
            multiplier: TP_SEAT_MULT[winner],
            isGlobal: true,
          });
        } catch {}
      }

      res.json({
        hands: {
          A: handA,
          B: handB,
          C: handC,
        },
        handRanks:  { A: evalA.rank, B: evalB.rank, C: evalC.rank },
        handNames:  { A: evalA.name, B: evalB.name, C: evalC.name },
        winner,
        winAmount,
        nets: {
          A: winner === 'A' ? net : -betA,
          B: winner === 'B' ? net : -betB,
          C: winner === 'C' ? net : -betC,
        },
        net,
        newBalance: finalBalance,
      });
    } catch (e: any) {
      console.error("[TeenPatti] deal error:", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/teenpatti/top-winners ──────────────────────────────────
  app.get("/api/games/teenpatti/top-winners", async (req: Request, res: Response) => {
    try {
      await ensureTpTable();
      // Recent big wins (all players, last 2 hours), ordered by win amount
      const rows = await db.execute(sql`
        SELECT username, winner, winner_hand, win_amount, net, created_at
        FROM teenpatti_games
        WHERE net > 0
          AND created_at > NOW() - INTERVAL '2 hours'
        ORDER BY created_at DESC
        LIMIT 20
      `);
      // Fallback: if no wins in 2h, grab last 20 ever
      const data = rows.rows.length > 0 ? rows.rows : (await db.execute(sql`
        SELECT username, winner, winner_hand, win_amount, net, created_at
        FROM teenpatti_games
        WHERE net > 0
        ORDER BY created_at DESC
        LIMIT 20
      `)).rows;
      res.json({ winners: data });
    } catch (e: any) {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/teenpatti/history ───────────────────────────────────────
  app.get("/api/games/teenpatti/history", async (req: Request, res: Response) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    try {
      await ensureTpTable();
      const user = await storage.getUser(payload.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const rows = await db.execute(sql`
        SELECT winner, winner_hand, total_bet, win_amount, net, balance_after, created_at
        FROM teenpatti_games
        WHERE user_id = ${payload.userId}
        ORDER BY created_at DESC
        LIMIT 30
      `);
      res.json({ history: rows.rows });
    } catch (e: any) {
      res.status(500).json({ error: "Server error" });
    }
  });
}
