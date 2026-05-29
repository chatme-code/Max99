import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

interface FlagInfo {
  code: string;       // single-letter code
  name: string;       // display name
  hotkey: string;     // emoticon hotkey rendered client-side as image
  aliases: string[];  // accepted typed aliases (lowercase)
}

const FLAGS: Record<string, FlagInfo> = {
  s: { code: "s", name: "Suami",   hotkey: "(suami)",   aliases: ["s",  "suami"] },
  i: { code: "i", name: "Istri",   hotkey: "(istri)",   aliases: ["i",  "istri"] },
  d: { code: "d", name: "Duda",    hotkey: "(duda)",    aliases: ["d",  "duda"] },
  j: { code: "j", name: "Janda",   hotkey: "(janda)",   aliases: ["j",  "janda"] },
  b: { code: "b", name: "Binor",   hotkey: "(binor)",   aliases: ["b",  "binor"] },
  p: { code: "p", name: "Pelakor", hotkey: "(pelakor)", aliases: ["p",  "pelakor"] },
};

const FLAG_CODES = Object.keys(FLAGS);

const MULTIPLIERS: Record<number, number> = {
  1: 0,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
};

const HOUSE_FEE = 0.10;

interface PlayerBet {
  username: string;
  flagCode: string;
  amount: number;       // cumulative
}

function fmtIDR(n: number): string {
  return `IDR ${Math.round(n)}`;
}

function resolveFlagAlias(token: string): string | null {
  const t = token.toLowerCase();
  for (const code of FLAG_CODES) {
    if (FLAGS[code].aliases.includes(t)) return code;
  }
  return null;
}

export class TebakHati extends BotBase {
  readonly gameType = "pelakor";

  private waitForBetsMs:   number;
  private rollDelayMs:     number;
  private idleMs:          number;
  private minBet:          number;
  private maxBet:          number;
  private minPlayers:      number;

  private playerBets    = new Map<string, PlayerBet>(); // key = `${username}:${flagCode}`
  private totalPot      = 0;
  private bettingEndsAt = 0;
  private timeLastGameFinished = Date.now();
  private gameStarter:  string | null = null;

  private waitTimer: NodeJS.Timeout | null = null;
  private rollTimer: NodeJS.Timeout | null = null;

  constructor(ctx: BotContext) {
    super(ctx);
    this.waitForBetsMs = this.param("WaitForBetsInterval", 45_000);
    this.rollDelayMs   = this.param("RollDelayInterval",    3_000);
    this.idleMs        = this.param("IdleInterval", 1_800_000);
    this.minBet        = this.param("MinBet",    100);
    this.maxBet        = this.param("MaxBet", 10_000_000);
    this.minPlayers    = this.param("MinPlayers", 1);

    this.sendChannelMessage(
      `Bot ${this.botDisplayName} added to room by ${this.starterUsername ?? "system"}.`
    );
    this.sendChannelMessage(this.helpLine());
  }

  get botDisplayName(): string {
    return "PelakorBot";
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME &&
      Date.now() - this.timeLastGameFinished > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state !== BotState.PLAYING &&
      this.state !== BotState.GAME_JOINING &&
      this.state !== BotState.GAME_STARTING;
  }

  stopBot(): void {
    this.clearTimers();
    this.refundAll().catch(() => {});
    this.endGame();
  }

  onUserJoinChannel(username: string): void {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(this.helpLine(), username);
    } else if (this.state === BotState.PLAYING) {
      const sec = Math.max(0, Math.round((this.bettingEndsAt - Date.now()) / 1000));
      this.sendMessage(
        `Tebak Hati is on now. Betting ends in ${sec}s. ` +
        `Place a bet: !bet <image> <amount>`,
        username
      );
    }
  }

  onUserLeaveChannel(_username: string): void {
    // bets remain in pot — payouts still apply
  }

  onMessage(username: string, text: string, _ts: number): void {
    const raw = text.trim();
    const msg = raw.toLowerCase();

    if (msg.startsWith("!start")) {
      this.startCmd(username).catch(e => console.error("[tebakhati]", e));
      return;
    }
    if (msg.startsWith("!bet ")) {
      this.betCmd(username, raw).catch(e => console.error("[tebakhati]", e));
      return;
    }
    if (msg === "!list" || msg === "!images" || msg === "!help") {
      this.sendMessage(this.helpLine(), username);
      this.sendMessage(this.imagesLine(), username);
      return;
    }
    if (msg === "!pot") {
      this.sendMessage(this.potSummary(), username);
      return;
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  private async startCmd(username: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage("A game is currently in progress. Please wait for next game", username);
      return;
    }
    this.state         = BotState.PLAYING;
    this.gameStarter   = username;
    this.totalPot      = 0;
    this.playerBets.clear();
    this.bettingEndsAt = Date.now() + this.waitForBetsMs;

    const sec = Math.round(this.waitForBetsMs / 1000);
    this.sendChannelMessage(
      `Tebak Hati started by ${username}. ` +
      `Place your bet in ${sec} seconds. Format: !bet <image> <amount IDR>`
    );
    this.sendChannelMessage(this.imagesLine());

    this.rollTimer = setTimeout(() => this.closeBetting(), this.waitForBetsMs);
  }

  private async betCmd(username: string, raw: string): Promise<void> {
    if (this.state !== BotState.PLAYING) {
      this.sendMessage("No game in progress. Enter !start to start a game", username);
      return;
    }
    if (Date.now() > this.bettingEndsAt) {
      this.sendMessage("Betting time is up", username);
      return;
    }

    const parts = raw.trim().split(/\s+/);
    if (parts.length < 3) {
      this.sendMessage("Format: !bet <image> <amount>. Example: !bet pelakor 100", username);
      return;
    }

    const flagCode = resolveFlagAlias(parts[1]);
    if (!flagCode) {
      this.sendMessage(
        `Invalid image. Choose: ${Object.values(FLAGS).map(f => f.name.toLowerCase()).join(", ")}`,
        username
      );
      return;
    }

    const amount = parseInt(parts[2], 10);
    if (isNaN(amount) || amount < this.minBet) {
      this.sendMessage(`Minimum bet is ${fmtIDR(this.minBet)}`, username);
      return;
    }
    if (amount > this.maxBet) {
      this.sendMessage(`Maximum bet is ${fmtIDR(this.maxBet)}`, username);
      return;
    }
    if (!(await this.userCanAfford(username, amount))) return;

    await this.chargeUser(username, amount);

    const key = `${username}:${flagCode}`;
    const existing = this.playerBets.get(key);
    const newAmount = (existing?.amount ?? 0) + amount;
    this.playerBets.set(key, { username, flagCode, amount: newAmount });
    this.totalPot += amount;

    const flag = FLAGS[flagCode];
    this.sendChannelMessage(
      `${username} bet ${fmtIDR(amount)} on ${flag.hotkey} ${flag.name} ` +
      `(total: ${fmtIDR(newAmount)}). Pot: ${fmtIDR(this.totalPot)}`
    );
  }

  // ─── Game flow ─────────────────────────────────────────────────────────────

  private closeBetting(): void {
    this.rollTimer = null;

    const uniquePlayers = new Set(Array.from(this.playerBets.values()).map(b => b.username));
    if (uniquePlayers.size < this.minPlayers || this.playerBets.size === 0) {
      this.sendChannelMessage("No bets placed. Game cancelled.");
      this.refundAll().then(() => this.endGame()).catch(() => this.endGame());
      this.sendChannelMessage(this.helpLine());
      return;
    }

    this.sendChannelMessage(`Time's up! Drawing 6 images in ${Math.round(this.rollDelayMs / 1000)}s...`);
    this.rollTimer = setTimeout(() => this.rollAndPayout().catch(e => console.error("[tebakhati]", e)),
      this.rollDelayMs);
  }

  private generateResults(): string[] {
    const results: string[] = [];

    // 25% chance lucky pattern (5 or 6 of a kind)
    if (Math.random() < 0.25) {
      const luckyCode = FLAG_CODES[Math.floor(Math.random() * FLAG_CODES.length)];
      const count = Math.random() < 0.3 ? 6 : 5;
      for (let i = 0; i < count; i++) results.push(luckyCode);
      while (results.length < 6) {
        results.push(FLAG_CODES[Math.floor(Math.random() * FLAG_CODES.length)]);
      }
      // shuffle
      for (let i = results.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [results[i], results[j]] = [results[j], results[i]];
      }
      return results;
    }

    for (let i = 0; i < 6; i++) {
      results.push(FLAG_CODES[Math.floor(Math.random() * FLAG_CODES.length)]);
    }
    return results;
  }

  private async rollAndPayout(): Promise<void> {
    this.rollTimer = null;

    const results = this.generateResults();
    const occurrences: Record<string, number> = {};
    for (const r of results) occurrences[r] = (occurrences[r] || 0) + 1;

    // Show results as a standalone line of 6 emoticon hotkeys — no "Result:"
    // text prefix so the client renders them as large inline images instead of
    // the smaller inline-with-text size.
    const resultLine = results.map(c => FLAGS[c].hotkey).join(" ");
    this.sendChannelMessage(resultLine);

    // Count summary — only show images that came up 2x or more (i.e. winning
    // counts). Each entry is sent as its OWN message so it stacks vertically
    // and the image hotkey is rendered large (one line per winning image),
    // followed by the image NAME and multiplier as text:
    //   (istri)  Image Istri x3
    //   (suami)  Image Suami x2
    //   (duda)   Image Duda  x2
    const winningEntries = Object.entries(occurrences)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1]);
    for (const [code, n] of winningEntries) {
      this.sendChannelMessage(`${FLAGS[code].hotkey} ${FLAGS[code].name} x${n}`);
    }

    // Payout
    const winnerLines: string[] = [];
    let totalPaid = 0;

    for (const bet of Array.from(this.playerBets.values())) {
      const count = occurrences[bet.flagCode] || 0;
      const mult = MULTIPLIERS[count] || 0;
      if (count >= 2 && mult > 0) {
        const netBet = bet.amount * (1 - HOUSE_FEE);
        const winAmount = Math.floor(netBet * (mult + 1));
        const profit = winAmount - bet.amount;
        await this.creditUser(bet.username, winAmount).catch(() => {});
        totalPaid += winAmount;
        winnerLines.push(
          `${bet.username} won ${fmtIDR(winAmount)} ` +
          `(${FLAGS[bet.flagCode].name} ${mult}x, profit ${profit >= 0 ? "+" : ""}${fmtIDR(profit)})`
        );
      } else {
        this.sendMessage(
          `Sorry, ${FLAGS[bet.flagCode].name} lost. You lost ${fmtIDR(bet.amount)}.`,
          bet.username
        );
      }
    }

    if (winnerLines.length > 0) {
      for (const line of winnerLines) this.sendChannelMessage(line);
    } else {
      this.sendChannelMessage("No winners this round. Pot goes to the house.");
    }

    this.sendChannelMessage(
      `Game over. Pot: ${fmtIDR(this.totalPot)}, paid out: ${fmtIDR(totalPaid)}.`
    );
    this.endGame();
    this.sendChannelMessage(this.helpLine());
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private potSummary(): string {
    if (this.playerBets.size === 0) return `Pot is empty: ${fmtIDR(this.totalPot)}`;
    const perFlag: Record<string, number> = {};
    for (const b of Array.from(this.playerBets.values())) {
      perFlag[b.flagCode] = (perFlag[b.flagCode] || 0) + b.amount;
    }
    const parts = Object.entries(perFlag)
      .map(([c, a]) => `${FLAGS[c].name}: ${fmtIDR(a)}`)
      .join(", ");
    return `Pot ${fmtIDR(this.totalPot)} — ${parts}`;
  }

  private imagesLine(): string {
    return "Images: " + Object.values(FLAGS)
      .map(f => `${f.hotkey} ${f.name} (!bet ${f.code})`)
      .join("  ");
  }

  private helpLine(): string {
    return `Play Tebak Hati. Enter !start to start a game. ` +
      `Bet ${fmtIDR(this.minBet)}–${fmtIDR(this.maxBet)}. ` +
      `Format: !bet <suami|istri|duda|janda|binor|pelakor> <amount IDR>. ` +
      `!list to see images, !pot to view pot, !help for help.`;
  }

  private async refundAll(): Promise<void> {
    for (const bet of Array.from(this.playerBets.values())) {
      if (bet.amount > 0) {
        await this.refundUser(bet.username, bet.amount).catch(() => {});
      }
    }
  }

  private clearTimers(): void {
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
    if (this.rollTimer) { clearTimeout(this.rollTimer); this.rollTimer = null; }
  }

  private endGame(): void {
    this.clearTimers();
    this.playerBets.clear();
    this.totalPot      = 0;
    this.bettingEndsAt = 0;
    this.gameStarter   = null;
    this.timeLastGameFinished = Date.now();
    this.state         = BotState.NO_GAME;
  }
}

import { gameRegistry } from "../../GameRegistry";
const pelakorDescriptor = {
  name: "pelakor",
  displayName: "Pelakor (Tebak Hati)",
  description: "Pasang taruhan IDR pada gambar — Suami, Istri, Duda, Janda, Binor, Pelakor.",
  category: "gambling" as const,
  factory: (ctx: BotContext) => new TebakHati(ctx),
};
gameRegistry.register(pelakorDescriptor);
// Alias: /bot tebakhati → same game
gameRegistry.register({ ...pelakorDescriptor, name: "tebakhati" });
