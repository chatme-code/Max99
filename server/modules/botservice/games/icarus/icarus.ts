import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

function fmt(n: number): string { return n.toFixed(2); }

function rollDie(): number { return Math.floor(Math.random() * 6) + 1; }

export class Icarus extends BotBase {
  readonly gameType = "icarus";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private rollTimeMs:      number;
  private betweenRoundMs:  number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;
  private skullFace:       number;
  private skullsToElim:    number;

  private costToJoin = 0;
  private players: string[] = [];
  private playerSkulls   = new Map<string, number>();
  private playerBanked   = new Map<string, number>();
  private playerRolled   = new Set<string>();
  private playerKept     = new Set<string>();
  private roundTotal     = new Map<string, number>();
  private round = 0;
  private waitTimer:  NodeJS.Timeout | null = null;
  private roundTimer: NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.maxPlayers      = this.param("MaxPlayers", 10);
    this.waitForPlayerMs = this.param("TimeToJoinGame", 60_000);
    this.rollTimeMs      = this.param("TimeToRoll", 15_000);
    this.betweenRoundMs  = this.param("TimeBetweenRounds", 5_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 500);
    this.skullFace       = this.param("SkullFace", 1);
    this.skullsToElim    = this.param("SkullsToEliminate", 3);

    this.sendChannelMessage(
      `Bot Icarus (Danger) added. !start to play. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      `Roll dice: !r=roll, !k=keep points. ${this.skullsToElim} skulls (roll=${this.skullFace}) = eliminated!`
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
        this.sendMessage(`Play Icarus Danger. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`Icarus forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("Icarus is in play. Wait for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.toLowerCase().trim();
    if (msg.startsWith("!start")) { this.startNewGame(username, msg).catch(e => console.error("[icarus]", e)); return; }
    if (msg === "!j") { this.joinGame(username).catch(e => console.error("[icarus]", e)); return; }
    if (msg === "!r") { this.roll(username); return; }
    if (msg === "!k") { this.keepPoints(username); return; }
    this.sendMessage(`${text} is not a valid command. !r=roll, !k=keep`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `Icarus forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`
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
    this.players = [username];
    this.playerSkulls.clear();
    this.playerBanked.clear();
    this.playerSkulls.set(username, 0);
    this.playerBanked.set(username, 0);
    this.sendChannelMessage(`${username} started Icarus Danger!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Wait for next game", username); return;
    }
    if (this.players.includes(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.players.length >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.players.push(username);
    this.playerSkulls.set(username, 0);
    this.playerBanked.set(username, 0);
    this.sendChannelMessage(`${username} joined Icarus`);
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
    if (this.players.length < this.minPlayers) {
      await this.refundAll();
      this.resetGame();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.state = BotState.PLAYING;
    this.sendChannelMessage(
      `Icarus Danger starts! ${this.players.length} players. ` +
      `Roll !r to earn points. !k to bank points safely. ${this.skullsToElim} skulls = eliminated!`
    );
    this.startRound();
  }

  private startRound(): void {
    this.round++;
    this.playerRolled.clear();
    this.playerKept.clear();
    this.roundTotal.clear();
    for (const p of this.players) {
      this.roundTotal.set(p, 0);
    }
    this.sendChannelMessage(
      `Round ${this.round}! Active: [${this.players.join(", ")}]. ` +
      `!r to roll dice. ${Math.round(this.rollTimeMs / 1000)}s to roll.`
    );
    this.roundTimer = setTimeout(() => this.resolveRound(), this.rollTimeMs);
  }

  private roll(username: string): void {
    if (this.state !== BotState.PLAYING) { this.sendMessage("No active round", username); return; }
    if (!this.players.includes(username)) { this.sendMessage("You are not in the game", username); return; }
    if (this.playerKept.has(username)) { this.sendMessage("You already banked this round", username); return; }
    const die = rollDie();
    if (die === this.skullFace) {
      const skulls = (this.playerSkulls.get(username) ?? 0) + 1;
      this.playerSkulls.set(username, skulls);
      this.roundTotal.set(username, 0);
      this.sendChannelMessage(`${username} rolled a SKULL! (${skulls}/${this.skullsToElim})`);
      if (skulls >= this.skullsToElim) {
        this.sendChannelMessage(`${username} is ELIMINATED with ${this.skullsToElim} skulls!`);
        this.players = this.players.filter(p => p !== username);
        this.playerBanked.delete(username);
        if (this.players.length === 0) { this.endGame(); return; }
      }
    } else {
      const current = this.roundTotal.get(username) ?? 0;
      this.roundTotal.set(username, current + die);
      this.sendChannelMessage(`${username} rolled ${die} (round total: ${current + die}). !k to bank, !r to roll again.`);
    }
    this.playerRolled.add(username);
  }

  private keepPoints(username: string): void {
    if (this.state !== BotState.PLAYING) { this.sendMessage("No active round", username); return; }
    if (!this.players.includes(username)) { this.sendMessage("You are not in the game", username); return; }
    if (this.playerKept.has(username)) { this.sendMessage("You already banked this round", username); return; }
    const earned = this.roundTotal.get(username) ?? 0;
    const banked = (this.playerBanked.get(username) ?? 0) + earned;
    this.playerBanked.set(username, banked);
    this.playerKept.add(username);
    this.sendChannelMessage(`${username} banks ${earned} points (total banked: ${banked}). Safe for now!`);
    if (this.playerKept.size >= this.players.length) {
      if (this.roundTimer) { clearTimeout(this.roundTimer); this.roundTimer = null; }
      this.resolveRound();
    }
  }

  private resolveRound(): void {
    this.roundTimer = null;
    this.sendChannelMessage(`--- Round ${this.round} scores ---`);
    for (const p of this.players) {
      const skulls = this.playerSkulls.get(p) ?? 0;
      const banked = this.playerBanked.get(p) ?? 0;
      this.sendChannelMessage(`  ${p}: skulls=${skulls}, banked=${banked}`);
    }
    if (this.players.length <= 1) { this.endGame(); return; }
    this.roundTimer = setTimeout(() => this.startRound(), this.betweenRoundMs);
  }

  private async endGame(): Promise<void> {
    if (this.players.length === 0) {
      this.sendChannelMessage("Everyone was eliminated! No winner. Enter !start to play again");
      this.resetGame();
      return;
    }
    const scores = this.players.map(p => ({ p, score: this.playerBanked.get(p) ?? 0 }));
    scores.sort((a, b) => b.score - a.score);
    const maxScore = scores[0].score;
    const winners = scores.filter(s => s.score === maxScore).map(s => s.p);
    const pot = (this.playerSkulls.size + this.players.length) * this.costToJoin;
    const share = winners.length > 0 ? pot / winners.length : 0;
    for (const w of winners) {
      if (share > 0) await this.refundUser(w, share).catch(() => {});
    }
    this.sendChannelMessage(
      `Icarus over! Winner${winners.length > 1 ? "s" : ""}: ${winners.join(", ")} ` +
      `(${maxScore} pts)${share > 0 ? ` — ${fmt(share)} credits each` : ""}. Enter !start to play again`
    );
    this.resetGame();
  }

  private async refundAll(): Promise<void> {
    for (const player of this.players) {
      if (this.costToJoin > 0) await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.players = [];
    this.playerSkulls.clear();
    this.playerBanked.clear();
    this.playerRolled.clear();
    this.playerKept.clear();
    this.roundTotal.clear();
    this.round = 0;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "icarus",
  displayName: "Icarus",
  description: "Terbang sejauh mungkin — tapi jangan terlalu tinggi!",
  category: "gambling",
  factory: ctx => new Icarus(ctx),
});
