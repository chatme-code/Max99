import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

function fmt(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(2); }

interface PlayerRoll {
  die1: number;       // 0 = not rolled yet
  die2: number;
  isWinner: boolean;
  entryCost: number;
}

function diceStr(die1: number, die2: number): string {
  return `(d${die1}) (d${die2})`;
}

export class Dice extends BotBase {
  readonly gameType = "dice";

  private waitForJoinMs:   number;
  private timeToRollMs:    number;
  private timeNewRoundMs:  number;
  private idleMs:          number;
  private entryAmount:     number;
  private baseEntryAmount: number;  // nilai awal dari config — tidak pernah berubah
  private maxEntryAmount:  number;
  readonly minPlayers:     number;

  private playerRolls  = new Map<string, PlayerRoll>();
  private safePlayers  = new Map<number, Set<string>>();   // roundNumber → immune players

  private botDie1    = 0;
  private botDie2    = 0;
  private botTotal   = 0;
  private gameStarter: string | null = null;
  private totalPot   = 0;   // accumulated from all players who joined

  private currentRound   = 0;
  private hasWinner      = false;
  private numPlayed      = 0;
  private isRoundStarted = false;

  private rollTimer: NodeJS.Timeout | null = null;
  private joinTimer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.waitForJoinMs  = this.param("timerJoinGame",   30_000);
    this.timeToRollMs   = this.param("timerRoll",       20_000);
    this.timeNewRoundMs = this.param("timerNewRound",    3_000);
    this.idleMs         = this.param("timerIdle",       30 * 60_000);
    // Minimum bet dipatok di 500 IDR (floor — DB tidak bisa menurunkan di bawah ini)
    this.baseEntryAmount = Math.max(500, this.param("amountJoinPot", 500));
    this.entryAmount     = this.baseEntryAmount;
    // Maksimum bet bebas (tanpa batas) — secara teknis dipatok di MAX_SAFE_INTEGER
    this.maxEntryAmount = this.param("maxAmountJoinPot", Number.MAX_SAFE_INTEGER);
    this.minPlayers     = this.param("MinPlayers",          2);

    this.sendChannelMessage(`Bot ${this.botDisplayName} added to room by ${this.starterUsername ?? "system"}.`);
    this.sendChannelMessage(
      this.entryAmount > 0
        ? `Play now: !start to enter. Cost: IDR ${fmt(this.entryAmount)}. For custom entry, !start <entry_amount>`
        : `Play Dice: !start. Need ${this.minPlayers} players.`
    );
    this.updateActivity();
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME && Date.now() - this.lastActivity > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state !== BotState.PLAYING &&
      this.state !== BotState.GAME_JOINING &&
      this.state !== BotState.GAME_STARTING;
  }

  stopBot(): void {
    this.clearTimers();
    this.refundAll().catch(() => {});
    this.resetGame(false);
  }

  onUserJoinChannel(username: string): void {
    this.sendMessage(
      `[PVT] ${this.botDisplayName} is Running! !start to start a game. !j to join game. Amount = ${fmt(this.entryAmount)} IDR`,
      username
    );
  }

  onUserLeaveChannel(username: string): void {
    if (this.playerRolls.has(username)) {
      this.playerRolls.delete(username);
      this.sendChannelMessage(`${username} left the game`);
      if (this.state === BotState.PLAYING && this.playerRolls.size < this.minPlayers) {
        this.clearTimers();
        this.pickWinner().catch(() => {});
      }
    }
  }

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.trim();
    if (msg.toLowerCase().startsWith("!start")) { this.startCmd(username, msg).catch(e => console.error("[dice]", e)); return; }
    if (msg === "!j") { this.joinCmd(username).catch(e => console.error("[dice]", e)); return; }
    if (msg === "!r") {
      if (this.state === BotState.PLAYING && this.isRoundStarted) {
        if (!this.playerRolls.has(username)) {
          this.sendMessage(`${username}: you're not in the game.`, username);
        } else {
          this.roll(username, false);
        }
      } else {
        this.sendMessage(`${username}: Invalid command.`, username);
      }
      return;
    }
    if (msg === "!n") { this.noCmd(username); return; }
  }

  private async startCmd(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage("[PVT] A game is already in progress. Please wait", username);
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let amount = this.entryAmount;
    if (parts.length > 1) {
      const parsed = parseFloat(parts[1]);
      if (isNaN(parsed) || parsed < this.entryAmount) {
        this.sendMessage(
          `${username}: Invalid amount. Minimum entry is IDR ${fmt(this.entryAmount)}`, username
        );
        return;
      }
      if (parsed > this.maxEntryAmount) {
        this.sendMessage(`${username}: Maximum bet is IDR ${fmt(this.maxEntryAmount)}`, username);
        return;
      }
      amount = parsed;
    }
    if (amount > 0 && !(await this.userCanAfford(username, amount))) return;

    this.entryAmount = amount;
    this.state = BotState.GAME_STARTING;
    this.gameStarter = username;

    if (amount > 0) {
      this.sendMessage(
        `${username}: Charges apply. IDR ${fmt(amount)} Create/enter pot. !n to cancel. ${Math.round(this.waitForJoinMs / 1000)} seconds`,
        username
      );
    }

    this.joinTimer = setTimeout(() => this.startPlay(username), this.waitForJoinMs / 6);
    this.updateActivity();
  }

  private async startPlay(starter: string): Promise<void> {
    this.joinTimer = null;
    this.state = BotState.GAME_JOINING;

    if (this.entryAmount > 0 && !(await this.userCanAfford(starter, this.entryAmount))) {
      this.resetGame(false);
      return;
    }
    if (this.entryAmount > 0) await this.chargeUser(starter, this.entryAmount);
    this.playerRolls.set(starter, { die1: 0, die2: 0, isWinner: false, entryCost: this.entryAmount });
    this.totalPot += this.entryAmount;

    const sec = Math.round(this.waitForJoinMs / 1000);
    this.sendChannelMessage(
      this.entryAmount > 0
        ? `Dice started by ${starter}. !j to join. Cost IDR ${fmt(this.entryAmount)}. ${sec} seconds`
        : `Dice started. !j to join. ${sec} seconds`
    );

    this.joinTimer = setTimeout(() => this.beginPlay(), this.waitForJoinMs);
  }

  private async beginPlay(): Promise<void> {
    this.joinTimer = null;
    if (this.playerRolls.size < this.minPlayers) {
      this.sendChannelMessage(`Joining ends. Not enough players. Need ${this.minPlayers}.`);
      await this.refundAll();
      this.resetGame(false);
      return;
    }
    this.sendChannelMessage("Game begins! Bot rolls first - match or beat total to stay IN");
    this.state = BotState.PLAYING;
    this.newRound();
  }

  private async joinCmd(username: string): Promise<void> {
    if (!this.playerRolls.has(username)) {
      if (this.state === BotState.GAME_JOINING) {
        await this.addPlayer(username);
      } else if (this.state === BotState.PLAYING) {
        this.sendMessage(`${username}: Sorry, a game has already started.`, username);
      } else {
        this.sendMessage(`${username}: Invalid command.`, username);
      }
    } else {
      this.sendMessage(`${username}: You're already in the game.`, username);
    }
  }

  private async addPlayer(username: string): Promise<void> {
    if (this.entryAmount > 0 && !(await this.userCanAfford(username, this.entryAmount))) return;
    if (this.entryAmount > 0) await this.chargeUser(username, this.entryAmount);
    this.playerRolls.set(username, { die1: 0, die2: 0, isWinner: false, entryCost: this.entryAmount });
    this.totalPot += this.entryAmount;
    const msg = this.entryAmount > 0
      ? `${username}: added to game. Charges apply. IDR ${fmt(this.entryAmount)}`
      : `${username}: added to game.`;
    this.sendMessage(msg, username);
    this.sendChannelMessage(`${username} joined the Dice game`);
  }

  private noCmd(username: string): void {
    if (this.state === BotState.GAME_STARTING && username === this.gameStarter) {
      this.refundAll().catch(() => {});
      this.resetGame(false);
      this.sendMessage("Game cancelled.", username);
    } else {
      this.sendMessage(`${username}: Invalid command.`, username);
    }
  }

  private newRound(): void {
    this.isRoundStarted = true;
    this.currentRound++;
    this.hasWinner = false;
    this.numPlayed = 0;
    this.updateActivity();

    // Reset all dice (set back to 0 = not rolled)
    this.botDie1 = Math.floor(Math.random() * 6) + 1;
    this.botDie2 = Math.floor(Math.random() * 6) + 1;
    this.botTotal = this.botDie1 + this.botDie2;
    for (const pr of this.playerRolls.values()) {
      pr.die1 = 0;
      pr.die2 = 0;
      pr.isWinner = false;
    }

    // Show current player list
    const playerList = [...this.playerRolls.keys()].join(", ");
    this.sendChannelMessage(`Players: ${playerList}`);

    const botDisplay = diceStr(this.botDie1, this.botDie2);
    this.sendChannelMessage(`ROUND ${this.currentRound}: Bot rolled ${botDisplay}. Your TARGET: ${this.botTotal}!`);
    this.sendChannelMessage(`Players: !r to roll. ${Math.round(this.timeToRollMs / 1000)} seconds.`);

    this.rollTimer = setTimeout(() => {
      this.sendChannelMessage("TIME'S UP! Tallying rolls...");
      this.tallyRolls();
    }, this.timeToRollMs);
  }

  private roll(username: string, auto: boolean): void {
    const pr = this.playerRolls.get(username);
    if (!pr) return;

    if (pr.die1 !== 0) {
      // Already rolled
      if (!auto) {
        this.sendMessage(`${username}: you already rolled.`, username);
      } else {
        // auto-roll on already rolled player — skip
      }
      return;
    }

    // Roll
    pr.die1 = Math.floor(Math.random() * 6) + 1;
    pr.die2 = Math.floor(Math.random() * 6) + 1;
    const total  = pr.die1 + pr.die2;
    const disp   = diceStr(pr.die1, pr.die2);
    pr.isWinner  = total >= this.botTotal;

    if (total === this.botTotal) {
      // MATCH → IN
      this.sendChannelMessage(auto ? `Bot rolls - ${username}: ${disp} IN!` : `${username}: ${disp} IN!`);
      if (!this.hasWinner) this.hasWinner = true;

    } else if (total > this.botTotal) {
      // HIGHER → IN
      this.sendChannelMessage(auto ? `Bot rolls - ${username}: ${disp} IN!` : `${username}: ${disp} IN!`);
      if (!this.hasWinner) this.hasWinner = true;

      // Perfect roll: 12 = immunity next round
      if (total === 12) {
        this.addSafePlayer(this.currentRound + 1, username);
        this.sendChannelMessage(`${username}: ${disp} = immunity for the next round!`);
      }

    } else {
      // LOWER → OUT
      if (this.isSafePlayer(this.currentRound, username)) {
        this.sendChannelMessage(`${username}: ${disp} OUT but SAFE by immunity!`);
      } else {
        this.sendChannelMessage(auto ? `Bot rolls - ${username}: ${disp} OUT!` : `${username}: ${disp} OUT!`);
      }
    }

    // Manual roll: check if everyone has rolled
    if (!auto) {
      this.numPlayed++;
      if (this.numPlayed >= this.playerRolls.size) {
        // Cancel timer and tally immediately
        if (this.rollTimer) { clearTimeout(this.rollTimer); this.rollTimer = null; }
        this.tallyRolls();
      }
    }
  }

  private async tallyRolls(): Promise<void> {
    this.rollTimer = null;
    const losers: string[] = [];

    for (const [player, pr] of this.playerRolls) {
      // Auto-roll anyone who hasn't rolled
      if (pr.die1 === 0) {
        this.roll(player, true);
      }

      // Track if at least one winner
      if (pr.isWinner && !this.hasWinner) this.hasWinner = true;

      // Mark losers (not winner, not immune)
      if (!pr.isWinner && !this.isSafePlayer(this.currentRound, player)) {
        losers.push(player);
      }
    }

    if (this.hasWinner) {
      // Remove losers; send PVT message in order (await each to preserve message sequence)
      for (const loser of losers) {
        this.playerRolls.delete(loser);
        await this.sendMessage(`${loser}: sorry you LOST!`, loser);
      }
    }

    this.removeSafeList(this.currentRound);

    if (this.playerRolls.size > 1) {
      if (!this.hasWinner) {
        this.sendChannelMessage("Nobody won, so we'll try again!");
      }
      this.isRoundStarted = false;
      const nextRound = this.currentRound + 1;
      this.sendChannelMessage(`Players, get ready for round ${nextRound}!`);
      this.rollTimer = setTimeout(() => this.newRound(), this.timeNewRoundMs);

    } else if (this.playerRolls.size === 1) {
      await this.pickWinner();
    } else {
      // Size 0: all eliminated simultaneously — this shouldn't happen with hasWinner logic
      // but handle gracefully by replaying
      this.sendChannelMessage("Nobody won, so we'll try again!");
      this.isRoundStarted = false;
      this.rollTimer = setTimeout(() => this.newRound(), this.timeNewRoundMs);
    }
  }

  private async pickWinner(): Promise<void> {
    const winner  = [...this.playerRolls.keys()][0];
    const pot     = this.totalPot;
    const FEE_PCT = 0.10;
    const prize   = pot > 0 ? pot * (1 - FEE_PCT) : 0;

    if (prize > 0) {
      await this.creditUser(winner, prize).catch(() => {});
      this.sendChannelMessage(`Game over! ${winner} WINS IDR ${fmt(prize)}!! CONGRATS!`);
    } else {
      this.sendChannelMessage(`Game over! ${winner} wins!! CONGRATS!`);
    }

    this.sendChannelMessage(
      this.entryAmount > 0
        ? `Play now: !start to enter. Cost: IDR ${fmt(this.entryAmount)}. For custom entry, !start <entry_amount>`
        : `Play Dice: !start. Need ${this.minPlayers} players.`
    );
    this.resetGame(false);
  }

  // ─── Safe Player (Immunity) helpers ─────────────────────────────────────────

  private addSafePlayer(round: number, username: string): void {
    let set = this.safePlayers.get(round);
    if (!set) { set = new Set(); this.safePlayers.set(round, set); }
    set.add(username);
  }

  private isSafePlayer(round: number, username: string): boolean {
    return this.safePlayers.get(round)?.has(username) ?? false;
  }

  private removeSafeList(round: number): void {
    this.safePlayers.delete(round);
  }

  // ─── Refund / Reset helpers ──────────────────────────────────────────────────

  private async refundAll(): Promise<void> {
    for (const [player, pr] of this.playerRolls) {
      if (pr.entryCost > 0) {
        await this.refundUser(player, pr.entryCost).catch(() => {});
      }
    }
  }

  private clearTimers(): void {
    if (this.rollTimer) { clearTimeout(this.rollTimer); this.rollTimer = null; }
    if (this.joinTimer) { clearTimeout(this.joinTimer); this.joinTimer = null; }
  }

  private resetGame(cancel: boolean): void {
    this.clearTimers();
    if (cancel) this.refundAll().catch(() => {});
    this.playerRolls.clear();
    this.safePlayers.clear();
    this.botDie1        = 0;
    this.botDie2        = 0;
    this.botTotal       = 0;
    this.totalPot       = 0;
    this.currentRound   = 0;
    this.hasWinner      = false;
    this.numPlayed      = 0;
    this.isRoundStarted = false;
    this.lastActivity   = Date.now();
    this.state          = BotState.NO_GAME;
    // Kembalikan entryAmount ke nilai awal config agar tidak "nyangkut" di custom amount
    this.entryAmount    = this.baseEntryAmount;
  }

  private updateActivity(): void {
    this.lastActivity = Date.now();
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "dice",
  displayName: "Dice",
  description: "Lempar dadu — kalahkan angka bot untuk menang!",
  category: "gambling",
  factory: ctx => new Dice(ctx),
});
