import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

type Role = "VILLAGER" | "WEREWOLF" | "SEER";
type Phase = "DAY" | "NIGHT";

function fmt(n: number): string { return n.toFixed(2); }
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Werewolf extends BotBase {
  readonly gameType = "werewolf";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private dayMs:           number;
  private nightMs:         number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;

  private costToJoin = 0;
  private alive: string[] = [];
  private roles = new Map<string, Role>();
  private votes = new Map<string, string>();
  private nightKill: string | null = null;
  private phase: Phase = "DAY";
  private waitTimer:  NodeJS.Timeout | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 4);
    this.maxPlayers      = this.param("MaxPlayers", 20);
    this.waitForPlayerMs = this.param("TimeToJoinGame", 60_000);
    this.dayMs           = this.param("DayDuration", 60_000);
    this.nightMs         = this.param("NightDuration", 30_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 500);

    this.sendChannelMessage(
      `Bot Werewolf added. !start to play. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      "Villagers must eliminate all werewolves!"
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
        this.sendMessage(`Play Werewolf. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`Werewolf forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("Werewolf game in progress. Watch out!", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.trim();
    const lower = msg.toLowerCase();
    if (lower.startsWith("!start")) { this.startNewGame(username, lower).catch(e => console.error("[werewolf]", e)); return; }
    if (lower === "!j") { this.joinGame(username).catch(e => console.error("[werewolf]", e)); return; }
    if (lower.startsWith("!v ")) { this.vote(username, msg.slice(3).trim()); return; }
    if (lower.startsWith("!k ")) { this.nightAction(username, msg.slice(3).trim(), "KILL"); return; }
    if (lower.startsWith("!s ")) { this.nightAction(username, msg.slice(3).trim(), "SEER"); return; }
    if (lower === "!alive") { this.sendAlive(username); return; }
    if (lower === "!role") { this.sendRole(username); return; }
    this.sendMessage("Commands: !v <player>=vote, !k <player>=kill (werewolf), !s <player>=see (seer), !alive, !role", username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `Werewolf forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`
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
    this.alive = [username];
    this.roles.clear();
    this.sendChannelMessage(`${username} started Werewolf!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Watch the action!", username); return;
    }
    if (this.alive.includes(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.alive.length >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.alive.push(username);
    this.sendChannelMessage(`${username} joined Werewolf`);
  }

  private vote(username: string, target: string): void {
    if (this.state !== BotState.PLAYING || this.phase !== "DAY") {
      this.sendMessage("You can only vote during the day", username); return;
    }
    if (!this.alive.includes(username)) { this.sendMessage("You are not alive", username); return; }
    if (!this.alive.includes(target)) {
      this.sendMessage(`${target} is not in the game or already eliminated`, username); return;
    }
    if (target === username) { this.sendMessage("You cannot vote for yourself", username); return; }
    this.votes.set(username, target);
    this.sendChannelMessage(`${username} voted to eliminate ${target}`);
  }

  private nightAction(username: string, target: string, type: "KILL" | "SEER"): void {
    if (this.state !== BotState.PLAYING || this.phase !== "NIGHT") {
      this.sendMessage("This command is only available at night", username); return;
    }
    if (!this.alive.includes(username)) { this.sendMessage("You are not alive", username); return; }
    const role = this.roles.get(username);
    if (type === "KILL" && role !== "WEREWOLF") { this.sendMessage("Only werewolves can kill at night", username); return; }
    if (type === "SEER" && role !== "SEER") { this.sendMessage("Only the seer can investigate at night", username); return; }
    if (!this.alive.includes(target) || target === username) {
      this.sendMessage(`${target} is not a valid target`, username); return;
    }
    if (type === "KILL") {
      this.nightKill = target;
      this.sendMessage(`You target ${target}...`, username);
    } else {
      const targetRole = this.roles.get(target);
      this.sendMessage(
        `${target} is a ${targetRole === "WEREWOLF" ? "WEREWOLF" : "villager"} (role: ${targetRole})`,
        username
      );
    }
  }

  private sendAlive(username: string): void {
    this.sendMessage(`Alive: [${this.alive.join(", ")}]`, username);
  }

  private sendRole(username: string): void {
    const role = this.roles.get(username);
    if (role) this.sendMessage(`Your role: ${role}`, username);
    else this.sendMessage("You are not in this game", username);
  }

  private waitForPlayers(): void {
    this.state = BotState.GAME_JOINING;
    this.sendChannelMessage(
      `Waiting for players. !j to join. Entry: ${fmt(this.costToJoin)} credits. ` +
      `${Math.round(this.waitForPlayerMs / 1000)}s to join. Min ${this.minPlayers} players.`
    );
    this.waitTimer = setTimeout(() => this.beginGame(), this.waitForPlayerMs);
  }

  private async beginGame(): Promise<void> {
    this.waitTimer = null;
    if (this.alive.length < this.minPlayers) {
      await this.refundAll();
      this.resetGame();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.assignRoles();
    this.state = BotState.PLAYING;
    this.sendChannelMessage(
      `Werewolf game begins! ${this.alive.length} players. Roles assigned privately. ` +
      `!v <player> to vote. !alive for player list. !role for your role. !k (werewolf) !s (seer).`
    );
    for (const p of this.alive) {
      const role = this.roles.get(p)!;
      this.sendMessage(`Your role: ${role}`, p);
    }
    this.startDay();
  }

  private assignRoles(): void {
    const shuffled = shuffle(this.alive);
    const wolvesCount = Math.max(1, Math.floor(shuffled.length / 4));
    shuffled.forEach((p, i) => {
      if (i < wolvesCount) this.roles.set(p, "WEREWOLF");
      else if (i === wolvesCount) this.roles.set(p, "SEER");
      else this.roles.set(p, "VILLAGER");
    });
  }

  private startDay(): void {
    this.phase = "DAY";
    this.votes.clear();
    const wolves = this.alive.filter(p => this.roles.get(p) === "WEREWOLF").length;
    const secs = Math.round(this.dayMs / 1000);
    this.sendChannelMessage(
      `--- DAY TIME --- ${this.alive.length} players alive (${wolves} werewolves hidden). ` +
      `Vote to eliminate with !v <player>. ${secs}s to vote.`
    );
    this.phaseTimer = setTimeout(() => this.resolveDay(), this.dayMs);
  }

  private async resolveDay(): Promise<void> {
    this.phaseTimer = null;
    const tally = new Map<string, number>();
    for (const target of this.votes.values()) {
      tally.set(target, (tally.get(target) ?? 0) + 1);
    }

    let eliminated: string | null = null;
    if (tally.size > 0) {
      const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      const maxVotes = sorted[0][1];
      const topVoted = sorted.filter(([, v]) => v === maxVotes).map(([p]) => p);
      if (topVoted.length === 1) {
        eliminated = topVoted[0];
      }
    }

    if (eliminated) {
      const role = this.roles.get(eliminated);
      this.alive = this.alive.filter(p => p !== eliminated);
      this.sendChannelMessage(`The village eliminated ${eliminated}! They were a ${role}.`);
    } else {
      this.sendChannelMessage("No consensus. No one was eliminated today.");
    }

    const over = await this.checkWinCondition();
    if (!over) this.startNight();
  }

  private startNight(): void {
    this.phase = "NIGHT";
    this.nightKill = null;
    const secs = Math.round(this.nightMs / 1000);
    this.sendChannelMessage(
      `--- NIGHT TIME --- Village sleeps. Werewolves: !k <player>. Seer: !s <player>. ` +
      `${secs}s until dawn.`
    );
    this.phaseTimer = setTimeout(() => this.resolveNight(), this.nightMs);
  }

  private async resolveNight(): Promise<void> {
    this.phaseTimer = null;
    if (this.nightKill && this.alive.includes(this.nightKill)) {
      const victim = this.nightKill;
      const role = this.roles.get(victim);
      this.alive = this.alive.filter(p => p !== victim);
      this.sendChannelMessage(`Dawn breaks... ${victim} was killed in the night! They were a ${role}.`);
    } else {
      this.sendChannelMessage("Dawn breaks... everyone survived the night.");
    }
    const over = await this.checkWinCondition();
    if (!over) this.startDay();
  }

  private async checkWinCondition(): Promise<boolean> {
    const wolves = this.alive.filter(p => this.roles.get(p) === "WEREWOLF");
    const villagers = this.alive.filter(p => this.roles.get(p) !== "WEREWOLF");

    if (wolves.length === 0) {
      const pot = this.roles.size * this.costToJoin;
      const share = villagers.length > 0 ? pot / villagers.length : 0;
      for (const v of villagers) {
        if (share > 0) await this.refundUser(v, share).catch(() => {});
      }
      this.sendChannelMessage(
        `VILLAGERS WIN! All werewolves eliminated. ` +
        `[${villagers.join(", ")}] survive${share > 0 ? ` — ${fmt(share)} credits each` : ""}. ` +
        `Enter !start to play again`
      );
      this.resetGame();
      return true;
    }

    if (wolves.length >= villagers.length) {
      const pot = this.roles.size * this.costToJoin;
      const share = wolves.length > 0 ? pot / wolves.length : 0;
      for (const w of wolves) {
        if (share > 0) await this.refundUser(w, share).catch(() => {});
      }
      this.sendChannelMessage(
        `WEREWOLVES WIN! [${wolves.join(", ")}]${share > 0 ? ` — ${fmt(share)} credits each` : ""}. ` +
        `Enter !start to play again`
      );
      this.resetGame();
      return true;
    }

    return false;
  }

  private async refundAll(): Promise<void> {
    for (const player of this.alive) {
      if (this.costToJoin > 0) await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.alive = [];
    this.roles.clear();
    this.votes.clear();
    this.nightKill = null;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "werewolf",
  displayName: "Werewolf",
  description: "Game deduksi sosial — Villager vs Werewolf. Temukan serigala!",
  category: "social",
  factory: ctx => new Werewolf(ctx),
});
