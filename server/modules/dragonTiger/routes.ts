import type { Express, Request } from "express";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";
import { verifyJwt } from "../../middleware/jwtAuth";
import { broadcastToAllClients } from "../../gateway";

// ─── Dragon & Tiger — Shared Pool System ───────────────────────────────────────
//
// Semua user bermain dalam ronde yang SAMA.
// Bet dikumpul jadi pool bersama. Setelah timer habis, kartu dibuka.
// User yang bet ke pemenang dapat bagian proporsional dari total pool.
// House cut 5% — app TIDAK pernah rugi.
//
// GET  /api/games/dragon/balance        — coin balance
// GET  /api/games/dragon/round          — current round state + pool info
// POST /api/games/dragon/bet            — place bet { side, bet }
// GET  /api/games/dragon/history        — personal round history
// GET  /api/games/dragon/top-winners    — leaderboard 24h
// POST /api/games/dragon/admin/resolve  — force resolve (admin debug)

const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
const MIN_BET    = 1_000;
const HOUSE_CUT  = 0.05;       // 5% dari total pool
const ROUND_SECS = 20;         // detik betting phase
const RESOLVE_DELAY_MS = 2000; // jeda sebelum resolve setelah betting tutup
const TIE_REFUND = true;       // jika tidak ada yang bet Seri saat tie, refund semua

type Suit = typeof SUITS[number];
interface Card { rank: number; suit: Suit; }
type Side = "dragon" | "tiger" | "tie";
type RoundStatus = "betting" | "resolving" | "resolved";

interface ActiveRound {
  id: number;
  status: RoundStatus;
  startedAt: number;   // epoch ms
  endsAt: number;      // epoch ms (betting closes)
  bets: Map<string, { side: Side; amount: number; username: string }>;
  poolDragon: number;
  poolTiger: number;
  poolTie: number;
  dragonCard?: Card;
  tigerCard?: Card;
  winner?: Side;
  resolveTimer?: ReturnType<typeof setTimeout>;
}

function dealCard(): Card {
  return {
    rank: Math.floor(Math.random() * 13) + 1,
    suit: SUITS[Math.floor(Math.random() * 4)],
  };
}

function resolveWinner(dragon: Card, tiger: Card): Side {
  if (dragon.rank > tiger.rank) return "dragon";
  if (tiger.rank > dragon.rank) return "tiger";
  return "tie";
}

function getToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return (req.query.token as string | undefined) ?? null;
}

// ─── In-memory active round ────────────────────────────────────────────────────
let activeRound: ActiveRound | null = null;
let nextRoundId = 1;
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS dt_rounds (
      id           SERIAL PRIMARY KEY,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at  TIMESTAMPTZ,
      dragon_rank  INT,
      dragon_suit  TEXT,
      tiger_rank   INT,
      tiger_suit   TEXT,
      winner       TEXT,
      total_pool   BIGINT NOT NULL DEFAULT 0,
      house_cut    BIGINT NOT NULL DEFAULT 0,
      pool_dragon  BIGINT NOT NULL DEFAULT 0,
      pool_tiger   BIGINT NOT NULL DEFAULT 0,
      pool_tie     BIGINT NOT NULL DEFAULT 0
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS dt_bets (
      id           SERIAL PRIMARY KEY,
      round_id     INT NOT NULL,
      user_id      TEXT NOT NULL,
      username     TEXT NOT NULL,
      side         TEXT NOT NULL,
      bet          BIGINT NOT NULL,
      payout       BIGINT NOT NULL DEFAULT 0,
      net          BIGINT NOT NULL DEFAULT 0,
      balance_after BIGINT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tablesReady = true;
}

// ─── Start a new shared round ──────────────────────────────────────────────────
async function startNewRound(): Promise<ActiveRound> {
  await ensureTables();

  // Insert round row to DB, get auto-incremented id
  const result = await db.execute(sql`
    INSERT INTO dt_rounds (total_pool) VALUES (0) RETURNING id
  `);
  const dbId = Number((result.rows[0] as any).id);

  const now = Date.now();
  activeRound = {
    id: dbId,
    status: "betting",
    startedAt: now,
    endsAt: now + ROUND_SECS * 1000,
    bets: new Map(),
    poolDragon: 0,
    poolTiger: 0,
    poolTie: 0,
  };

  // Broadcast new round to all connected clients
  broadcastRoundState();

  // Schedule auto-resolve when betting closes
  activeRound.resolveTimer = setTimeout(() => resolveRound(), ROUND_SECS * 1000 + RESOLVE_DELAY_MS);

  console.log(`[DT] Round ${dbId} started, betting until ${new Date(activeRound.endsAt).toISOString()}`);
  return activeRound;
}

// ─── Resolve the current round ─────────────────────────────────────────────────
async function resolveRound() {
  if (!activeRound || activeRound.status !== "betting") return;

  activeRound.status = "resolving";
  clearTimeout(activeRound.resolveTimer);

  const round = activeRound;
  const dragonCard = dealCard();
  const tigerCard  = dealCard();
  const winner     = resolveWinner(dragonCard, tigerCard);

  round.dragonCard = dragonCard;
  round.tigerCard  = tigerCard;
  round.winner     = winner;

  const totalPool  = round.poolDragon + round.poolTiger + round.poolTie;
  const houseCut   = Math.floor(totalPool * HOUSE_CUT);
  const prizePool  = totalPool - houseCut;

  // Winning side pool
  const winnerPool = winner === "dragon" ? round.poolDragon
                   : winner === "tiger"  ? round.poolTiger
                   : round.poolTie;

  // Detect solo play: only 1 player OR winner side has nobody opposing
  // (all bets on same side = no opposing pool to redistribute from)
  const totalPlayers   = round.bets.size;
  const loserPool      = totalPool - winnerPool;
  const isSoloMode     = totalPlayers <= 1 || loserPool === 0;

  // Fixed multipliers used in solo / no-opponent mode (app pays from house)
  // NAGA/HARIMAU ×2 → player gets double bet | SERI ×8 → rare but safe
  const SOLO_MULT: Record<Side, number> = { dragon: 2, tiger: 2, tie: 8 };

  console.log(`[DT] Round ${round.id} resolved: ${winner.toUpperCase()} | pool=${totalPool} prize=${prizePool} winnerPool=${winnerPool} players=${totalPlayers} soloMode=${isSoloMode}`);

  // ── Pay out each bettor ────────────────────────────────────────────────────
  let biggestWin = 0;
  let biggestWinUser = "";

  for (const [userId, bet] of round.bets) {
    let payout = 0;
    let net    = -bet.amount;

    if (bet.side === winner) {
      if (isSoloMode) {
        // Solo mode: fixed multiplier payout from house
        payout = Math.floor(bet.amount * SOLO_MULT[winner]);
        net    = payout - bet.amount;
      } else if (winnerPool > 0) {
        // Pool mode: proportional share of prize pool
        payout = Math.floor((bet.amount / winnerPool) * prizePool);
        net    = payout - bet.amount;
      }
    } else if (winner === "tie" && TIE_REFUND && bet.side !== "tie" && !isSoloMode) {
      // Pool mode tie: refund non-tie bettors
      payout = bet.amount;
      net = 0;
    } else if (winner === "tie" && isSoloMode && bet.side !== "tie") {
      // Solo mode tie: refund
      payout = bet.amount;
      net = 0;
    }

    // Credit payout
    let balanceAfter: number | null = null;
    if (payout > 0) {
      try {
        const acct = await storage.adjustBalance(bet.username, payout);
        balanceAfter = acct.balance;
      } catch (e) {
        console.error(`[DT] payout error for ${bet.username}:`, e);
      }
    } else {
      try {
        const acct = await storage.getCreditAccount(bet.username);
        balanceAfter = acct.balance;
      } catch {}
    }

    // Record bet result
    await db.execute(sql`
      UPDATE dt_bets
      SET payout=${payout}, net=${net}, balance_after=${balanceAfter}
      WHERE round_id=${round.id} AND user_id=${userId}
    `).catch(() => {});

    if (net > biggestWin) {
      biggestWin = net;
      biggestWinUser = bet.username;
    }
  }

  // Update round record
  await db.execute(sql`
    UPDATE dt_rounds
    SET resolved_at=NOW(),
        dragon_rank=${dragonCard.rank}, dragon_suit=${dragonCard.suit},
        tiger_rank=${tigerCard.rank},   tiger_suit=${tigerCard.suit},
        winner=${winner},
        total_pool=${totalPool}, house_cut=${houseCut},
        pool_dragon=${round.poolDragon},
        pool_tiger=${round.poolTiger},
        pool_tie=${round.poolTie}
    WHERE id=${round.id}
  `).catch(() => {});

  round.status = "resolved";

  // Broadcast result to everyone
  broadcastToAllClients({
    type: "DT_ROUND_RESULT",
    roundId: round.id,
    dragonCard,
    tigerCard,
    winner,
    totalPool,
    houseCut,
    poolDragon: round.poolDragon,
    poolTiger: round.poolTiger,
    poolTie: round.poolTie,
    prizePool,
    winnerPool,
    isSoloMode,
    soloMult: SOLO_MULT,
  });

  // Broadcast big win if applicable
  if (biggestWin >= 50_000) {
    broadcastToAllClients({
      type: "GAME_WIN",
      eventId: `gw-dt-${biggestWinUser}-${Date.now()}`,
      username: biggestWinUser,
      gameName: "Dragon & Tiger",
      gameEmoji: "🐉",
      amount: biggestWin,
      slotEmoji: winner === "dragon" ? "🐲" : winner === "tiger" ? "🐯" : "🤝",
      multiplier: 0,
      isGlobal: true,
    });
  }

  // Start next round after short delay
  setTimeout(async () => {
    activeRound = null;
    await startNewRound();
  }, 5000);
}

// ─── Broadcast current round state ────────────────────────────────────────────
function broadcastRoundState() {
  if (!activeRound) return;
  const r = activeRound;
  const now = Date.now();
  broadcastToAllClients({
    type: "DT_ROUND_STATE",
    roundId: r.id,
    status: r.status,
    startedAt: r.startedAt,
    endsAt: r.endsAt,
    secondsLeft: Math.max(0, Math.ceil((r.endsAt - now) / 1000)),
    totalPool: r.poolDragon + r.poolTiger + r.poolTie,
    poolDragon: r.poolDragon,
    poolTiger: r.poolTiger,
    poolTie: r.poolTie,
    playerCount: r.bets.size,
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────────
export function registerDragonTigerRoutes(app: Express) {

  // Auto-start first round when routes register
  ensureTables().then(() => startNewRound()).catch(console.error);

  // ── GET /api/games/dragon/balance ────────────────────────────────────────────
  app.get("/api/games/dragon/balance", async (req, res) => {
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

  // ── GET /api/games/dragon/round ──────────────────────────────────────────────
  // Returns current round state so frontend can sync on load
  app.get("/api/games/dragon/round", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    if (!activeRound) {
      // Should not happen; start one if missing
      await startNewRound();
    }
    const r = activeRound!;
    const now = Date.now();
    const userBet = r.bets.get(payload.userId);

    res.json({
      roundId: r.id,
      status: r.status,
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      secondsLeft: Math.max(0, Math.ceil((r.endsAt - now) / 1000)),
      totalPool: r.poolDragon + r.poolTiger + r.poolTie,
      poolDragon: r.poolDragon,
      poolTiger: r.poolTiger,
      poolTie: r.poolTie,
      playerCount: r.bets.size,
      myBet: userBet ? { side: userBet.side, amount: userBet.amount } : null,
      // Include result if resolved
      dragonCard: r.dragonCard,
      tigerCard: r.tigerCard,
      winner: r.winner,
    });
  });

  // ── POST /api/games/dragon/bet ───────────────────────────────────────────────
  // Body: { side: "dragon"|"tiger"|"tie", bet: number }
  // User can only bet once per round, on one side
  app.post("/api/games/dragon/bet", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    const side = req.body.side as Side;
    const bet  = Number(req.body.bet);

    if (!["dragon", "tiger", "tie"].includes(side)) {
      return res.status(400).json({ error: "Side tidak valid" });
    }
    if (!bet || bet < MIN_BET || !Number.isInteger(bet)) {
      return res.status(400).json({ error: `Bet minimal ${MIN_BET.toLocaleString("id-ID")} koin` });
    }

    // Ensure round exists and is open for betting
    if (!activeRound || activeRound.status !== "betting") {
      return res.status(409).json({ error: "Ronde sedang tidak menerima taruhan, tunggu ronde berikutnya" });
    }
    if (Date.now() >= activeRound.endsAt) {
      return res.status(409).json({ error: "Waktu taruhan sudah habis, tunggu ronde berikutnya" });
    }

    const round = activeRound;

    // Each user can only place one bet per round (can add to same side)
    const existing = round.bets.get(payload.userId);
    if (existing && existing.side !== side) {
      return res.status(409).json({ error: "Kamu sudah bet di sisi lain pada ronde ini. Hanya 1 sisi per ronde." });
    }

    try {
      await ensureTables();
      const user = await storage.getUser(payload.userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const acct = await storage.getCreditAccount(user.username);
      if (acct.balance < bet) {
        return res.status(402).json({ error: "Koin tidak cukup" });
      }

      // Deduct bet from user balance immediately
      const afterDeduct = await storage.adjustBalance(user.username, -bet);

      if (existing) {
        // Add to existing bet on same side
        existing.amount += bet;
        // Update pool
        if (side === "dragon") round.poolDragon += bet;
        else if (side === "tiger") round.poolTiger += bet;
        else round.poolTie += bet;

        // Update DB
        await db.execute(sql`
          UPDATE dt_bets
          SET bet = bet + ${bet}
          WHERE round_id = ${round.id} AND user_id = ${payload.userId}
        `);
      } else {
        // New bet
        round.bets.set(payload.userId, { side, amount: bet, username: user.username });
        if (side === "dragon") round.poolDragon += bet;
        else if (side === "tiger") round.poolTiger += bet;
        else round.poolTie += bet;

        // Insert to DB
        await db.execute(sql`
          INSERT INTO dt_bets (round_id, user_id, username, side, bet)
          VALUES (${round.id}, ${payload.userId}, ${user.username}, ${side}, ${bet})
        `);
      }

      // Update total_pool in DB
      const totalPool = round.poolDragon + round.poolTiger + round.poolTie;
      await db.execute(sql`
        UPDATE dt_rounds SET total_pool = ${totalPool} WHERE id = ${round.id}
      `);

      // Broadcast updated pool to all
      broadcastRoundState();

      const now = Date.now();
      res.json({
        success: true,
        roundId: round.id,
        side,
        myBetTotal: existing ? existing.amount : bet,
        newBalance: afterDeduct.balance,
        secondsLeft: Math.max(0, Math.ceil((round.endsAt - now) / 1000)),
        totalPool,
        poolDragon: round.poolDragon,
        poolTiger: round.poolTiger,
        poolTie: round.poolTie,
        playerCount: round.bets.size,
      });
    } catch (e: any) {
      console.error("[DT] bet error:", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/dragon/history ────────────────────────────────────────────
  app.get("/api/games/dragon/history", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });
    try {
      await ensureTables();
      const rows = await db.execute(sql`
        SELECT b.side, b.bet, b.payout, b.net, b.created_at,
               r.dragon_rank, r.dragon_suit, r.tiger_rank, r.tiger_suit,
               r.winner, r.total_pool, r.pool_dragon, r.pool_tiger, r.pool_tie
        FROM dt_bets b
        JOIN dt_rounds r ON r.id = b.round_id
        WHERE b.user_id = ${payload.userId}
          AND r.resolved_at IS NOT NULL
        ORDER BY b.created_at DESC
        LIMIT 20
      `);
      res.json({ history: rows.rows });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });

  // ── GET /api/games/dragon/top-winners ────────────────────────────────────────
  app.get("/api/games/dragon/top-winners", async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });
    try {
      await ensureTables();
      const rows = await db.execute(sql`
        SELECT b.username,
               SUM(b.net)    AS total_net,
               SUM(b.payout) AS total_win,
               COUNT(*)      AS rounds_played
        FROM dt_bets b
        JOIN dt_rounds r ON r.id = b.round_id
        WHERE b.net > 0
          AND b.created_at > NOW() - INTERVAL '24 hours'
        GROUP BY b.username
        ORDER BY total_net DESC
        LIMIT 10
      `);
      const stats = await db.execute(sql`
        SELECT COALESCE(SUM(b.payout),0) AS total_paid_out,
               COUNT(*) AS total_bets
        FROM dt_bets b
        WHERE b.net > 0
          AND b.created_at > NOW() - INTERVAL '24 hours'
      `);
      const s = stats.rows[0] as any;
      res.json({
        winners: rows.rows.map((r: any, i: number) => ({
          rank:         i + 1,
          username:     r.username,
          amount:       Number(r.total_net),
          rounds:       Number(r.rounds_played),
        })),
        totalPaidOut: Number(s?.total_paid_out ?? 0),
        totalBets:    Number(s?.total_bets ?? 0),
      });
    } catch {
      res.status(500).json({ error: "Server error" });
    }
  });
}
