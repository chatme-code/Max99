import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

function fmt(n: number): string { return n.toFixed(2); }

export class Esp extends BotBase {
  readonly gameType = "esp";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private betweenRoundMs:  number;
  private guessTimeMs:     number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;
  private minRange:        number;
  private maxRange:        number;
  private finalRound:      number;

  private costToJoin = 0;
  private playerGuesses  = new Map<string, number | null>();
  private playerScores   = new Map<string, number>();
  private round = 0;
  private waitPeriod = false;
  private waitTimer:  NodeJS.Timeout | null = null;
  private roundTimer: NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.maxPlayers      = this.param("MaxPlayers", 5);
    this.waitForPlayerMs = this.param("TimeToJoinGame", 60_000);
    this.betweenRoundMs  = this.param("TimeBetweenRounds", 10_000);
    this.guessTimeMs     = this.param("TimeToGuess", 20_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 500);
    this.minRange        = this.param("MinRange", 1);
    this.maxRange        = this.param("MaxRange", 11);
    this.finalRound      = this.param("FinalRound", 5);

    this.sendChannelMessage(
      `Bot ESP (Guess) added. !start to play. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      `Guess numbers ${this.minRange}–${this.maxRange}.`
    );
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME && Date.now() - this.timeLastGameFinished > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state === BotState.NO_GAME;
  }

  stopBot(): void {
    this.clearAllTimers();
    this.refundAll().catch(() => {});
    this.resetGame();
  }

  onUserJoinChannel(username: string): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(`Play ESP Guess. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`ESP game forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("ESP game in progress. Wait for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.toLowerCase().trim();
    if (msg.startsWith("!start")) { this.startNewGame(username, msg).catch(e => console.error("[esp]", e)); return; }
    if (msg === "!j") { this.joinGame(username).catch(e => console.error("[esp]", e)); return; }
    if (msg.startsWith("!")) {
      const numStr = msg.slice(1);
      const num = parseInt(numStr, 10);
      if (!isNaN(num)) {
        this.makeGuess(username, num); return;
      }
    }
    this.sendMessage(
      `${text} is not a valid command. !start, !j, or !<number> to guess`,
      username
    );
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `ESP forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`
          : "A game is in progress. Wait for next game",
        username
      );
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let cost = this.minCostToJoin;
    if (parts.length > 1) {
      const rawInput = parseFloat(parts[1]);
      const parsed = rawInput / 100;
      if (isNaN(parsed)) { this.sendMessage(`${parts[1]} is not a valid amount`, username); return; }
      if (parsed < this.minCostToJoin) { this.sendMessage(`Minimum entry is ${fmt(this.minCostToJoin)} credits`, username); return; }
      if (rawInput > this.maxCostToJoin) { this.sendMessage(`Maximum bet is ${this.maxCostToJoin} IDR`, username); return; }
      cost = parsed;
    }
    if (!(await this.userCanAfford(username, cost))) return;
    await this.chargeUser(username, cost);
    this.costToJoin = cost;
    this.round = 0;
    this.playerGuesses.clear();
    this.playerScores.clear();
    this.playerGuesses.set(username, null);
    this.playerScores.set(username, 0);
    this.sendChannelMessage(`${username} started ESP Guess!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Wait for next game", username); return;
    }
    if (this.playerGuesses.has(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.playerGuesses.size >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.playerGuesses.set(username, null);
    this.playerScores.set(username, 0);
    this.sendChannelMessage(`${username} joined ESP`);
  }

  private makeGuess(username: string, num: number): void {
    if (this.state !== BotState.PLAYING) {
      this.sendMessage("No active round", username); return;
    }
    if (!this.playerGuesses.has(username)) {
      this.sendMessage("You are not in the game", username); return;
    }
    if (this.waitPeriod) {
      this.sendMessage("Please wait till round begins", username); return;
    }
    if (num < this.minRange || num > this.maxRange) {
      this.sendMessage(`Guess a number from ${this.minRange}–${this.maxRange}`, username); return;
    }
    if (this.playerGuesses.get(username) !== null) {
      this.sendMessage("You already guessed this round", username); return;
    }
    this.playerGuesses.set(username, num);
    this.sendChannelMessage(`${username} guessed ${num}`);
  }

  private waitForPlayers(): void {
    this.state = BotState.GAME_JOINING;
    this.sendChannelMessage(
      `Waiting for players. !j to join. Entry: ${fmt(this.costToJoin)} credits. ` +
      `${Math.round(this.waitForPlayerMs / 1000)}s to join.`
    );
    this.waitTimer = setTimeout(() => this.beginGame(), this.waitForPlayerMs);
  }

  private async beginGame(): Promise<void> {
    this.waitTimer = null;
    if (this.playerGuesses.size < this.minPlayers) {
      await this.refundAll();
      this.resetGame();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.state = BotState.PLAYING;
    this.sendChannelMessage(
      `Game begins! ${this.playerGuesses.size} players. ` +
      `Guess numbers ${this.minRange}–${this.maxRange}. ${this.finalRound} rounds total.`
    );
    this.waitForNextRound();
  }

  private waitForNextRound(): void {
    this.round++;
    this.waitPeriod = true;
    for (const player of this.playerGuesses.keys()) this.playerGuesses.set(player, null);
    this.sendChannelMessage(`Round #${this.round} starting in ${Math.round(this.betweenRoundMs / 1000)}s`);
    this.roundTimer = setTimeout(() => this.waitForGuesses(), this.betweenRoundMs);
  }

  private waitForGuesses(): void {
    this.waitPeriod = false;
    this.sendChannelMessage(
      `Round #${this.round}. Guess your number ${this.minRange}–${this.maxRange}! ` +
      `Use !<number>. ${Math.round(this.guessTimeMs / 1000)}s to guess.`
    );
    this.roundTimer = setTimeout(() => this.revealNumber(), this.guessTimeMs);
  }

  private async revealNumber(): Promise<void> {
    this.roundTimer = null;
    const magic = Math.floor(Math.random() * (this.maxRange - this.minRange)) + this.minRange;
    this.sendChannelMessage(`TIME'S UP! The magic number was ${magic}!`);

    const results: { player: string; guess: number | null; score: number; total: number }[] = [];
    for (const [player, guess] of this.playerGuesses) {
      const s = guess === null ? 0 : (guess === magic ? 2 : 1);
      const total = (this.playerScores.get(player) ?? 0) + s;
      this.playerScores.set(player, total);
      results.push({ player, guess, score: s, total });
    }

    results.sort((a, b) => b.total - a.total);
    this.sendChannelMessage(`Results Round #${this.round}:`);
    for (const r of results) {
      const label = r.guess === null ? "No guess +0" : (r.guess === magic ? `Correct ${r.guess}! +2` : `Incorrect ${r.guess} +1`);
      this.sendChannelMessage(`  ${r.player}: ${label} (total ${r.total})`);
    }

    if (this.round < this.finalRound) {
      this.waitForNextRound();
      return;
    }

    const maxScore = Math.max(...results.map(r => r.total));
    const winners = results.filter(r => r.total === maxScore).map(r => r.player);
    const pot = this.playerGuesses.size * this.costToJoin;
    const share = winners.length > 0 ? pot / winners.length : 0;
    for (const w of winners) {
      if (share > 0) await this.creditUser(w, share).catch(() => {});
    }
    this.sendChannelMessage(
      `Game over! Winner${winners.length > 1 ? "s" : ""}: ${winners.join(", ")} ` +
      `(score ${maxScore})${share > 0 ? ` — ${fmt(share)} credits each` : ""}. ` +
      `Enter !start to play again`
    );
    this.resetGame();
  }

  private async refundAll(): Promise<void> {
    for (const player of this.playerGuesses.keys()) {
      if (this.costToJoin > 0) await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.playerGuesses.clear();
    this.playerScores.clear();
    this.round = 0;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "esp",
  displayName: "ESP",
  description: "Tebak pola tersembunyi — uji indera keenammu!",
  category: "social",
  factory: ctx => new Esp(ctx),
});
