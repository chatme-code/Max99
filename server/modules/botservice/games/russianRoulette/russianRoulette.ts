import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

function fmt(n: number): string { return n.toFixed(2); }

interface PlayerEntry {
  entryCost: number;
}

export class RussianRoulette extends BotBase {
  readonly gameType = "russianroulette";

  private waitForJoinMs: number;
  private timeToSpinMs:  number;
  private idleMs:        number;
  private entryAmount:   number;
  private maxEntryAmount: number;
  private minPlayers:    number;

  private players: string[] = [];
  private playerEntries = new Map<string, PlayerEntry>();
  private playersRemaining: string[] = [];
  private currentPlayer: string | null = null;
  private currentRound = 0;
  private joinTimer: NodeJS.Timeout | null = null;
  private spinTimer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.waitForJoinMs = this.param("timerJoinGame",   90_000);
    this.timeToSpinMs  = this.param("timerSpin",       10_000);
    this.idleMs        = this.param("timerIdle",       30 * 60_000);
    this.entryAmount   = this.param("amountJoinPot",       5);
    this.maxEntryAmount = this.param("maxAmountJoinPot",  500);
    this.minPlayers    = this.param("MinPlayers",          2);

    this.sendChannelMessage(
      "Bot Russian Roulette added. !start to begin. " +
      `Entry: ${fmt(this.entryAmount)} credits. For custom entry: !start <amount>`
    );
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
    if (this.joinTimer) { clearTimeout(this.joinTimer); this.joinTimer = null; }
    if (this.spinTimer) { clearTimeout(this.spinTimer); this.spinTimer = null; }
    this.refundAll().catch(() => {});
    this.reset();
  }

  onUserJoinChannel(username: string): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          `Play Russian Roulette. !start to start. Entry: ${fmt(this.entryAmount)} credits`, username
        );
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Russian Roulette forming. !j to join. Entry: ${fmt(this.entryAmount)} credits`, username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("Russian Roulette is in progress. Get ready for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(username: string): void {
    if (!this.players.includes(username)) return;
    this.players = this.players.filter(p => p !== username);
    this.playersRemaining = this.playersRemaining.filter(p => p !== username);
    this.playerEntries.delete(username);
    this.sendChannelMessage(`${username} left the game`);
    if (this.state === BotState.PLAYING) {
      if (this.players.length < this.minPlayers) {
        this.endGame();
      } else if (username === this.currentPlayer) {
        if (this.spinTimer) { clearTimeout(this.spinTimer); this.spinTimer = null; }
        this.nextPlayer();
      }
    }
  }

  onMessage(username: string, text: string, ts: number): void {
    const msg = text.toLowerCase().trim();
    if (msg.startsWith("!start")) { this.startCmd(username, msg).catch(e => console.error("[russianRoulette]", e)); return; }
    if (msg === "!j")             { this.joinCmd(username).catch(e => console.error("[russianRoulette]", e));        return; }
    if (msg === "!s" && this.state === BotState.PLAYING) { this.spinCmd(username); return; }
    if (msg === "!n")             { this.noCmd(username);          return; }
    this.sendMessage(`${text} is not a valid command`, username);
  }

  private async startCmd(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage("A game is already in progress. Please wait", username);
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let amount = this.entryAmount;
    if (parts.length > 1) {
      const parsed = parseFloat(parts[1]);
      if (isNaN(parsed) || parsed < this.entryAmount) {
        this.sendMessage(
          `Invalid amount. Minimum entry is ${fmt(this.entryAmount)} credits`, username
        );
        return;
      }
      if (parsed > this.maxEntryAmount) {
        this.sendMessage(`Maximum bet is ${this.maxEntryAmount} credits`, username);
        return;
      }
      amount = parsed;
    }
    if (amount > 0 && !(await this.userCanAfford(username, amount))) return;
    if (amount > 0) await this.chargeUser(username, amount);
    this.entryAmount = amount;
    this.players = [username];
    this.playerEntries.set(username, { entryCost: amount });
    this.state = BotState.GAME_JOINING;
    this.lastActivity = Date.now();
    const sec = Math.round(this.waitForJoinMs / 1000);
    this.sendChannelMessage(
      `${username} started Russian Roulette! !j to join. ` +
      `Entry: ${fmt(amount)} credits. ${sec}s to join.`
    );
    this.joinTimer = setTimeout(() => this.beginGame(), this.waitForJoinMs);
  }

  private async joinCmd(username: string): Promise<void> {
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("No game is currently accepting players", username);
      return;
    }
    if (this.players.includes(username)) {
      this.sendMessage("You have already joined the game", username);
      return;
    }
    if (this.entryAmount > 0 && !(await this.userCanAfford(username, this.entryAmount))) return;
    if (this.entryAmount > 0) await this.chargeUser(username, this.entryAmount);
    this.players.push(username);
    this.playerEntries.set(username, { entryCost: this.entryAmount });
    this.sendChannelMessage(`${username} joined Russian Roulette`);
  }

  private spinCmd(username: string): void {
    if (username !== this.currentPlayer) {
      this.sendMessage("It's not your turn to spin!", username);
      return;
    }
    this.sendChannelMessage(`${username} spins the cylinder...`);
    if (this.spinTimer) { clearTimeout(this.spinTimer); this.spinTimer = null; }
    this.spin(username);
  }

  private noCmd(username: string): void {
    if (this.state === BotState.GAME_STARTING && username === this.starterUsername) {
      this.refundAll().catch(() => {});
      this.reset();
      this.sendMessage("Game cancelled", username);
    } else {
      this.sendMessage("Invalid command", username);
    }
  }

  private async beginGame(): Promise<void> {
    this.joinTimer = null;
    if (this.players.length < this.minPlayers) {
      await this.refundAll();
      this.reset();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.state = BotState.PLAYING;
    this.currentRound = 0;
    this.sendChannelMessage(
      `Russian Roulette begins with ${this.players.length} players! ` +
      `[${this.players.join(", ")}]`
    );
    this.nextPlayer();
  }

  private spin(player: string): void {
    const chamber = Math.floor(Math.random() * 6);
    if (chamber === 5) {
      this.sendChannelMessage(`*BANG* ${player} is eliminated!`);
      this.players = this.players.filter(p => p !== player);
      this.playersRemaining = this.playersRemaining.filter(p => p !== player);
    } else {
      this.sendChannelMessage(`*click* ${player} is safe this time!`);
    }

    if (this.players.length > 1) {
      this.nextPlayer();
    } else {
      this.endGame();
    }
  }

  private nextPlayer(): void {
    if (this.players.length <= 1) {
      this.endGame();
      return;
    }
    if (this.playersRemaining.length === 0) {
      this.playersRemaining = [...this.players];
      this.currentRound++;
      if (this.currentRound > 1) {
        this.sendChannelMessage(`--- Round ${this.currentRound} ---`);
      }
      this.sendChannelMessage(`Spin order: [${this.playersRemaining.join(", ")}]`);
    }
    this.currentPlayer = this.playersRemaining.shift()!;
    const sec = Math.round(this.timeToSpinMs / 1000);
    this.sendChannelMessage(
      `${this.currentPlayer}'s turn to spin! Type !s to spin. ${sec}s before auto-spin.`
    );
    this.spinTimer = setTimeout(() => {
      this.sendChannelMessage(`${this.currentPlayer} didn't spin in time. Auto-spinning...`);
      this.spin(this.currentPlayer!);
    }, this.timeToSpinMs);
  }

  private async endGame(): Promise<void> {
    if (this.spinTimer) { clearTimeout(this.spinTimer); this.spinTimer = null; }
    if (this.players.length === 1) {
      const winner = this.players[0];
      const totalPot = [...this.playerEntries.values()].reduce((s, e) => s + e.entryCost, 0);
      if (totalPot > 0) {
        await this.refundUser(winner, totalPot).catch(() => {});
      }
      this.sendChannelMessage(
        `${winner} is the last survivor and wins` +
        (totalPot > 0 ? ` ${fmt(totalPot)} credits` : "") + "! " +
        "Enter !start to play again"
      );
    } else {
      this.sendChannelMessage("Game ended. Enter !start to play again");
    }
    this.reset();
  }

  private async refundAll(): Promise<void> {
    for (const [player, entry] of this.playerEntries) {
      if (entry.entryCost > 0) {
        await this.refundUser(player, entry.entryCost).catch(() => {});
      }
    }
  }

  private reset(): void {
    if (this.joinTimer) { clearTimeout(this.joinTimer); this.joinTimer = null; }
    if (this.spinTimer) { clearTimeout(this.spinTimer); this.spinTimer = null; }
    this.players = [];
    this.playerEntries.clear();
    this.playersRemaining = [];
    this.currentPlayer = null;
    this.currentRound  = 0;
    this.lastActivity  = Date.now();
    this.state         = BotState.NO_GAME;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "russianroulette",
  displayName: "Russian Roulette",
  description: "Roulette Rusia — berani putar silinder?",
  category: "gambling",
  factory: ctx => new RussianRoulette(ctx),
});
