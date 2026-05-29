import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

type Action = "ATTACK" | "DEFEND" | "UNKNOWN";

function fmt(n: number): string { return n.toFixed(2); }

export class KnockOut extends BotBase {
  readonly gameType = "knockout";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private countDownMs:     number;
  private nextRoundMs:     number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;

  private costToJoin = 0;
  private playerActions = new Map<string, Action>();
  private round = 1;
  private waitTimer:  NodeJS.Timeout | null = null;
  private roundTimer: NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.maxPlayers      = this.param("MaxPlayers", 20);
    this.waitForPlayerMs = this.param("WaitForPlayerInterval", 30_000);
    this.countDownMs     = this.param("CountDownInterval", 15_000);
    this.nextRoundMs     = this.param("NextRoundInterval", 5_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 500);

    this.sendChannelMessage(
      `Bot KnockOut added. !start to play. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      "For custom entry: !start <amount>"
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
        this.sendMessage(`Play KnockOut. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`KnockOut forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("KnockOut is on. Get ready for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(username: string): void {
    if (this.playerActions.has(username) && this.state !== BotState.NO_GAME) {
      this.playerActions.delete(username);
      this.refundUser(username, this.costToJoin).catch(() => {});
      this.sendChannelMessage(`${username} left the game`);
    }
  }

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.toLowerCase().trim();
    if (msg.startsWith("!start")) { this.startNewGame(username, msg).catch(e => console.error("[knockout]", e)); return; }
    if (msg === "!j") { this.joinGame(username).catch(e => console.error("[knockout]", e)); return; }
    if (msg === "!a") { this.pickAction(username, "ATTACK"); return; }
    if (msg === "!d") { this.pickAction(username, "DEFEND"); return; }
    this.sendMessage(`${text} is not a valid command. Use !a (Attack) or !d (Defend)`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `KnockOut forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`
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
    this.round = 1;
    this.playerActions.clear();
    this.playerActions.set(username, "UNKNOWN");
    this.sendChannelMessage(`${username} started KnockOut!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Wait for next game", username); return;
    }
    if (this.playerActions.has(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.playerActions.size >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.playerActions.set(username, "UNKNOWN");
    this.sendChannelMessage(`${username} joined KnockOut`);
  }

  private pickAction(username: string, action: "ATTACK" | "DEFEND"): void {
    if (this.state !== BotState.PLAYING) {
      this.sendMessage("No active round", username); return;
    }
    if (!this.playerActions.has(username)) {
      this.sendMessage("You are not in the game", username); return;
    }
    const existing = this.playerActions.get(username);
    if (existing !== "UNKNOWN") {
      this.sendMessage(`You already chose to ${existing}`, username); return;
    }
    this.playerActions.set(username, action);
    this.sendMessage(`You chose to ${action}`, username);
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
    if (this.playerActions.size < this.minPlayers) {
      await this.refundAll();
      this.resetGame();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.countDown();
  }

  private countDown(): void {
    this.state = BotState.PLAYING;
    this.sendChannelMessage(
      `Round ${this.round++}. Choose! !a=ATTACK  !d=DEFEND. ` +
      `${Math.round(this.countDownMs / 1000)}s to decide.`
    );
    for (const player of this.playerActions.keys()) {
      this.playerActions.set(player, "UNKNOWN");
    }
    this.roundTimer = setTimeout(() => this.pickWinner(), this.countDownMs);
  }

  private async pickWinner(): Promise<void> {
    this.roundTimer = null;
    const attackers: string[] = [];
    const defenders: string[] = [];

    for (const [player, action] of this.playerActions) {
      const chosen: Action = action === "UNKNOWN"
        ? (Math.random() < 0.5 ? "ATTACK" : "DEFEND")
        : action;
      if (action === "UNKNOWN") this.sendMessage(`You didn't pick. Bot chose ${chosen} for you`, player);
      if (chosen === "ATTACK") attackers.push(player);
      else defenders.push(player);
    }

    this.sendChannelMessage(`ATTACK [${attackers.join(", ")}]  DEFEND [${defenders.join(", ")}]`);

    const botAction = Math.random() < 0.5 ? "ATTACK" : "DEFEND";
    let losers: string[];
    if (botAction === "ATTACK") {
      this.sendChannelMessage("Bot is ATTACKING — all attackers are KO'd!");
      losers = attackers;
    } else {
      this.sendChannelMessage("Bot is DEFENDING — attackers get glory, defenders are out!");
      losers = defenders;
    }

    if (losers.length === this.playerActions.size) {
      this.sendChannelMessage("Everyone is knocked out! Enter !start to play again");
      this.resetGame();
      return;
    }

    for (const loser of losers) {
      this.playerActions.delete(loser);
    }

    if (this.playerActions.size === 1) {
      const winner = [...this.playerActions.keys()][0];
      const pot = (losers.length + 1) * this.costToJoin;
      if (pot > 0) await this.refundUser(winner, pot).catch(() => {});
      this.sendChannelMessage(
        `${winner} wins${pot > 0 ? ` ${fmt(pot)} credits` : ""}! Enter !start to play again`
      );
      this.resetGame();
      return;
    }

    this.sendChannelMessage(
      `${this.playerActions.size} players left [${[...this.playerActions.keys()].join(", ")}]. ` +
      `Next round in ${Math.round(this.nextRoundMs / 1000)}s`
    );
    this.roundTimer = setTimeout(() => this.countDown(), this.nextRoundMs);
  }

  private async refundAll(): Promise<void> {
    for (const player of this.playerActions.keys()) {
      if (this.costToJoin > 0) await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.playerActions.clear();
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "knockout",
  displayName: "Knock Out",
  description: "Game kartu Knock Out — hindari kartu mematikan.",
  category: "gambling",
  factory: ctx => new KnockOut(ctx),
});
