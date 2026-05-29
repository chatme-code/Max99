import { BotState } from "./types";
import { storage } from "../../storage";
import { broadcastToRoom, broadcastToUser } from "../../gateway";
import { randomUUID } from "crypto";
import { Pot } from "./pot";
import { CREDIT_TRANSACTION_TYPE, LEADERBOARD_TYPE, LEADERBOARD_PERIOD } from "../../../shared/schema";
import { awardReputationScore } from "../reputation/routes";
export { Pot } from "./pot";
export { GameSpenderData, GameWinnerData, PayoutData } from "./payoutData";

const BOT_SENDER_COLOR = "679c57";

// Maps game type string → leaderboard "games played" key
const GAME_LB_PLAYED: Record<string, string> = {
  lowcard:   LEADERBOARD_TYPE.LOW_CARD_GAMES_PLAYED,
  dice:      LEADERBOARD_TYPE.DICE_GAMES_PLAYED,
  cricket:   LEADERBOARD_TYPE.CRICKET_GAMES_PLAYED,
  football:  LEADERBOARD_TYPE.FOOTBALL_GAMES_PLAYED,
  warriors:  LEADERBOARD_TYPE.WARRIORS_GAMES_PLAYED,
  pelakor:   LEADERBOARD_TYPE.TEBAK_HATI_GAMES_PLAYED,
};

// Maps game type string → leaderboard "most wins" key
const GAME_LB_WINS: Record<string, string> = {
  lowcard:   LEADERBOARD_TYPE.LOW_CARD_MOST_WINS,
  dice:      LEADERBOARD_TYPE.DICE_MOST_WINS,
  cricket:   LEADERBOARD_TYPE.CRICKET_MOST_WINS,
  football:  LEADERBOARD_TYPE.FOOTBALL_MOST_WINS,
  warriors:  LEADERBOARD_TYPE.WARRIORS_MOST_WINS,
  pelakor:   LEADERBOARD_TYPE.TEBAK_HATI_MOST_WINS,
};

const LB_PERIODS = [LEADERBOARD_PERIOD.DAILY, LEADERBOARD_PERIOD.WEEKLY, LEADERBOARD_PERIOD.ALL_TIME];

export interface BotContext {
  roomId: string;
  starterUsername: string;
  params: Record<string, string>;
}

export abstract class BotBase {
  readonly instanceId: string = randomUUID();
  protected readonly roomId: string;
  protected readonly starterUsername: string;
  protected readonly params: Record<string, string>;

  protected state: BotState = BotState.NO_GAME;
  protected timers: NodeJS.Timeout[] = [];

  constructor(ctx: BotContext) {
    this.roomId         = ctx.roomId;
    this.starterUsername = ctx.starterUsername;
    this.params         = ctx.params;
  }

  abstract get gameType(): string;
  abstract isIdle(): boolean;
  abstract canBeStoppedNow(): boolean;
  abstract stopBot(): void;
  abstract onUserJoinChannel(username: string): void;
  abstract onUserLeaveChannel(username: string): void;
  abstract onMessage(username: string, text: string, ts: number): void;

  protected schedule(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(fn, ms);
    this.timers.push(t);
    return t;
  }

  protected clearTimer(t: NodeJS.Timeout | null): void {
    if (t) clearTimeout(t);
  }

  protected clearAllTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Display name shown as the sender in chat, e.g. "DiceBot", "BlackjackBot" */
  get botDisplayName(): string {
    const g = this.gameType;
    return g.charAt(0).toUpperCase() + g.slice(1) + "Bot";
  }

  // Sequential message queue — ensures channel messages are delivered in the
  // exact order they are enqueued, even though storage.postMessage is async.
  private _msgQueue: Promise<void> = Promise.resolve();

  protected sendChannelMessage(text: string): void {
    this._msgQueue = this._msgQueue.then(() =>
      storage.postMessage(this.roomId, {
        senderUsername: this.botDisplayName,
        senderColor:    BOT_SENDER_COLOR,
        text,
        isSystem:       true,
      }).then(msg => {
        broadcastToRoom(this.roomId, { type: "MESSAGE", roomId: this.roomId, message: msg });
      }).catch(() => {})
    );
  }

  protected sendMessage(text: string, username: string): Promise<void> {
    return storage.getUserByUsername(username).then(user => {
      if (!user) return;
      // JANGAN simpan ke DB — pesan private tidak boleh masuk chat history
      // yang bisa dilihat user lain saat load room.
      // Buat synthetic message in-memory dan kirim HANYA ke user target.
      const msg = {
        id:             randomUUID(),
        roomId:         this.roomId,
        senderId:       null,
        senderUsername: this.botDisplayName,
        senderColor:    BOT_SENDER_COLOR,
        text:           `[PVT→${username}] ${text}`,
        isSystem:       true,
        createdAt:      new Date(),
      };
      broadcastToUser(user.id, { type: "MESSAGE", roomId: this.roomId, message: msg });
    }).catch(() => {});
  }

  protected async userCanAfford(username: string, cost: number): Promise<boolean> {
    if (cost <= 0) return true;
    try {
      const acct = await storage.getCreditAccount(username);
      if (acct.balance < cost) {
        this.sendMessage("You do not have sufficient credit to start a game", username);
        return false;
      }
      return true;
    } catch {
      this.sendMessage("You do not have sufficient credit to start a game", username);
      return false;
    }
  }

  /** Charge user for entering a game — records bet in credit history & leaderboard */
  protected async chargeUser(username: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    // Award participation XP (gamePlayed = +8 XP). Fires once per join, so a
    // player who plays 4 games in a minute earns +32 XP — already on par with
    // the throttled chat-flood ceiling, with the chance of also winning.
    this.awardGameXp(username, "gamePlayed");
    const updated = await storage.adjustBalance(username, -amount);
    const acct = await storage.getCreditAccount(username).catch(() => null);
    storage.createCreditTransaction({
      username,
      type: CREDIT_TRANSACTION_TYPE.GAME_BET,
      reference: `GAME-BET-${this.gameType.toUpperCase()}-${Date.now()}`,
      description: `Game bet: ${this.gameType}`,
      currency: acct?.currency ?? 'IDR',
      amount: -amount,
      fundedAmount: 0,
      tax: 0,
      runningBalance: updated.balance,
    }).catch(() => {});
    const lbPlayed = GAME_LB_PLAYED[this.gameType];
    if (lbPlayed) {
      for (const period of LB_PERIODS) {
        storage.upsertLeaderboardEntry(lbPlayed, period, username, 1, true).catch(() => {});
      }
    }
    // Always count toward global "total games played" leaderboard
    for (const period of LB_PERIODS) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.TOTAL_GAMES_PLAYED, period, username, 1, true).catch(() => {});
    }
  }

  /** Refund user when game is cancelled — records refund in credit history */
  protected async refundUser(username: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const updated = await storage.adjustBalance(username, amount);
    const acct = await storage.getCreditAccount(username).catch(() => null);
    storage.createCreditTransaction({
      username,
      type: CREDIT_TRANSACTION_TYPE.GAME_REFUND,
      reference: `GAME-REFUND-${this.gameType.toUpperCase()}-${Date.now()}`,
      description: `Game refund: ${this.gameType}`,
      currency: acct?.currency ?? 'IDR',
      amount,
      fundedAmount: 0,
      tax: 0,
      runningBalance: updated.balance,
    }).catch(() => {});
  }

  /**
   * Create a new Pot for this game.
   * Mirrors: Bot.pot = new Pot(this) in Java.
   * Game subclasses use this to manage player stakes:
   *   pot.enterPlayer(username, cost, this.chargeUser.bind(this))
   *   pot.payoutToWinner(winner, this.creditUser.bind(this))
   *   pot.cancel(this.refundUser.bind(this))
   */
  protected createPot(): Pot {
    return new Pot();
  }

  /**
   * Award reputation XP to a player for participating in / winning a bot game.
   * Mirrors how chat/gift actions feed the reputation system, so playing games
   * (lowcard, dice, cricket, one, tebakhati, …) actually moves the user up
   * the level table — and is faster per-action than chat flooding.
   */
  protected awardGameXp(username: string, kind: "gamePlayed" | "gameWon"): void {
    if (!username) return;
    awardReputationScore(username, kind).catch(() => {});
  }

  /** Credit user when they win a game — records win in credit history & leaderboard */
  protected async creditUser(username: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    // Every monetary game win also awards reputation XP (gameWon = +35 XP).
    // This makes playing bot games (lowcard, dice, cricket, one, tebakhati,
    // football, baccarat, blackjack, vampire, esp, trivia, knockout, …)
    // a meaningful XP source, not just chatting.
    this.awardGameXp(username, "gameWon");
    const updated = await storage.adjustBalance(username, amount);
    const acct = await storage.getCreditAccount(username).catch(() => null);
    storage.createCreditTransaction({
      username,
      type: CREDIT_TRANSACTION_TYPE.GAME_REWARD,
      reference: `GAME-WIN-${this.gameType.toUpperCase()}-${Date.now()}`,
      description: `Game win: ${this.gameType}`,
      currency: acct?.currency ?? 'IDR',
      amount,
      fundedAmount: 0,
      tax: 0,
      runningBalance: updated.balance,
    }).catch(() => {});
    const lbWins = GAME_LB_WINS[this.gameType];
    if (lbWins) {
      for (const period of LB_PERIODS) {
        storage.upsertLeaderboardEntry(lbWins, period, username, 1, true).catch(() => {});
      }
    }
    for (const period of LB_PERIODS) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.TOTAL_MOST_WINS, period, username, 1, true).catch(() => {});
    }
  }

  /** Refund all players currently in a pot. Convenience wrapper. */
  protected async refundPot(pot: Pot): Promise<void> {
    await pot.cancel(this.refundUser.bind(this));
  }

  protected param(key: string, def: number): number {
    const v = parseFloat(this.params[key] ?? "");
    return isNaN(v) ? def : v;
  }

  protected paramStr(key: string, def: string): string {
    return this.params[key] ?? def;
  }
}
