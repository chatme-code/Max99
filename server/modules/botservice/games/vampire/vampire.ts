import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

type Role = "HUMAN" | "VAMPIRE" | "SLAYER";
type Phase = "DAY" | "NIGHT";

const HOUSE_TAX_RATE = 0.10;

function fmt(n: number): string { return Math.round(n).toString(); }
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Vampire extends BotBase {
  readonly gameType = "vampire";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private dayMs:           number;
  private nightMs:         number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;

  private costToJoin = 0;
  private totalPot   = 0;
  private alive: string[] = [];
  private roles = new Map<string, Role>();
  private votes = new Map<string, string>();
  private nightBite:  string | null = null;
  private nightStake: string | null = null;
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
    this.minCostToJoin   = this.param("MinCostToJoinGame",  500);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 50_000);

    this.sendChannelMessage(
      `Bot Vampire added. !start to play. Min entry: IDR ${fmt(this.minCostToJoin)}. ` +
      "Humans must slay all vampires before being bitten!"
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
        this.sendMessage(`Play Vampire. !start to start. Min entry: IDR ${fmt(this.minCostToJoin)}`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`Vampire forming. !j to join. Entry: IDR ${fmt(this.costToJoin)}`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("Vampire game in progress. Beware the night!", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.trim();
    const lower = msg.toLowerCase();
    if (lower.startsWith("!start")) { this.startNewGame(username, lower).catch(e => console.error("[vampire]", e)); return; }
    if (lower === "!j") { this.joinGame(username).catch(e => console.error("[vampire]", e)); return; }
    if (lower.startsWith("!v ")) { this.vote(username, msg.slice(3).trim()); return; }
    if (lower.startsWith("!b ")) { this.nightAction(username, msg.slice(3).trim(), "BITE"); return; }
    if (lower.startsWith("!s ")) { this.nightAction(username, msg.slice(3).trim(), "STAKE"); return; }
    if (lower === "!alive") { this.sendAlive(username); return; }
    if (lower === "!role") { this.sendRole(username); return; }
    this.sendMessage("Commands: !v <player>=vote, !b <player>=bite (vampire), !s <player>=stake (slayer), !alive, !role", username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `Vampire forming. !j to join. Entry: IDR ${fmt(this.costToJoin)}`
          : "A game is in progress. Wait for next game",
        username
      );
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let cost = this.minCostToJoin;
    if (parts.length > 1) {
      const parsed = parseFloat(parts[1]);
      if (isNaN(parsed) || parsed <= 0) { this.sendMessage(`${parts[1]} is not a valid amount`, username); return; }
      if (parsed < this.minCostToJoin) { this.sendMessage(`Minimum entry is IDR ${fmt(this.minCostToJoin)}`, username); return; }
      if (parsed > this.maxCostToJoin) { this.sendMessage(`Maximum entry is IDR ${fmt(this.maxCostToJoin)}`, username); return; }
      cost = parsed;
    }
    if (!(await this.userCanAfford(username, cost))) return;
    await this.chargeUser(username, cost);
    this.costToJoin = cost;
    this.totalPot   = cost;
    this.alive = [username];
    this.roles.clear();
    this.sendChannelMessage(`${username} started Vampire!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: IDR ${fmt(this.minCostToJoin)}`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Beware!", username); return;
    }
    if (this.alive.includes(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.alive.length >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.totalPot += this.costToJoin;
    this.alive.push(username);
    this.sendChannelMessage(`${username} joined Vampire`);
  }

  private vote(username: string, target: string): void {
    if (this.state !== BotState.PLAYING || this.phase !== "DAY") {
      this.sendMessage("You can only vote during the day", username); return;
    }
    if (!this.alive.includes(username)) { this.sendMessage("You are not alive", username); return; }
    if (!this.alive.includes(target) || target === username) {
      this.sendMessage(`${target} is not a valid vote target`, username); return;
    }
    this.votes.set(username, target);
    this.sendChannelMessage(`${username} voted to expose ${target}`);
  }

  private nightAction(username: string, target: string, type: "BITE" | "STAKE"): void {
    if (this.state !== BotState.PLAYING || this.phase !== "NIGHT") {
      this.sendMessage("This command is only available at night", username); return;
    }
    if (!this.alive.includes(username)) { this.sendMessage("You are not alive", username); return; }
    const role = this.roles.get(username);
    if (type === "BITE" && role !== "VAMPIRE") { this.sendMessage("Only vampires can bite at night", username); return; }
    if (type === "STAKE" && role !== "SLAYER") { this.sendMessage("Only the slayer can stake at night", username); return; }
    if (!this.alive.includes(target) || target === username) {
      this.sendMessage(`${target} is not a valid target`, username); return;
    }
    if (type === "BITE") {
      this.nightBite = target;
      this.sendMessage(`You sink your fangs into ${target}...`, username);
    } else {
      this.nightStake = target;
      this.sendMessage(`You raise your stake towards ${target}...`, username);
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
      `Waiting for players. !j to join. Entry: IDR ${fmt(this.costToJoin)}. ` +
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
      `Vampire game begins! ${this.alive.length} players. Roles assigned privately. ` +
      `!v <player> to vote. !alive for players. !role for your role.`
    );
    for (const p of this.alive) {
      const role = this.roles.get(p)!;
      let hint = "";
      if (role === "VAMPIRE") hint = " You win by converting all humans!";
      else if (role === "SLAYER") hint = " You can stake one vampire per night with !s <player>.";
      else hint = " Vote to expose vampires during the day!";
      this.sendMessage(`Your role: ${role}.${hint}`, p);
    }
    this.startDay();
  }

  private assignRoles(): void {
    const shuffled = shuffle(this.alive);
    const vamps = Math.max(1, Math.floor(shuffled.length / 4));
    shuffled.forEach((p, i) => {
      if (i < vamps) this.roles.set(p, "VAMPIRE");
      else if (i === vamps) this.roles.set(p, "SLAYER");
      else this.roles.set(p, "HUMAN");
    });
  }

  private startDay(): void {
    this.phase = "DAY";
    this.votes.clear();
    const vamps = this.alive.filter(p => this.roles.get(p) === "VAMPIRE").length;
    const secs = Math.round(this.dayMs / 1000);
    this.sendChannelMessage(
      `--- DAY --- ${this.alive.length} alive (${vamps} vampires lurk). ` +
      `!v <player> to vote to expose. ${secs}s.`
    );
    this.phaseTimer = setTimeout(() => this.resolveDay(), this.dayMs);
  }

  private async resolveDay(): Promise<void> {
    this.phaseTimer = null;
    const tally = new Map<string, number>();
    for (const target of this.votes.values()) {
      tally.set(target, (tally.get(target) ?? 0) + 1);
    }

    let exposed: string | null = null;
    if (tally.size > 0) {
      const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      const maxVotes = sorted[0][1];
      const topVoted = sorted.filter(([, v]) => v === maxVotes).map(([p]) => p);
      if (topVoted.length === 1) exposed = topVoted[0];
    }

    if (exposed) {
      const role = this.roles.get(exposed);
      this.alive = this.alive.filter(p => p !== exposed);
      this.sendChannelMessage(`Exposed! ${exposed} was a ${role}! They are driven away.`);
    } else {
      this.sendChannelMessage("No consensus. No one was exposed today.");
    }

    const over = await this.checkWinCondition();
    if (!over) this.startNight();
  }

  private startNight(): void {
    this.phase = "NIGHT";
    this.nightBite = null;
    this.nightStake = null;
    const secs = Math.round(this.nightMs / 1000);
    this.sendChannelMessage(
      `--- NIGHT --- Darkness falls. Vampires: !b <player>. Slayer: !s <player>. ` +
      `${secs}s until dawn.`
    );
    this.phaseTimer = setTimeout(() => this.resolveNight(), this.nightMs);
  }

  private async resolveNight(): Promise<void> {
    this.phaseTimer = null;

    if (this.nightBite && this.alive.includes(this.nightBite)) {
      const victim = this.nightBite;
      if (this.nightStake === victim) {
        this.sendChannelMessage(`Dawn: ${victim} was bitten and staked simultaneously — a miracle! Both cancel out.`);
      } else {
        const victimRole = this.roles.get(victim)!;
        if (victimRole !== "VAMPIRE") {
          this.roles.set(victim, "VAMPIRE");
          this.sendChannelMessage(`Dawn: ${victim} was bitten in the night! They have turned into a VAMPIRE!`);
          this.sendMessage("You were bitten in the night! You are now a VAMPIRE. Use !b <player> at night.", victim);
        }
      }
    } else if (this.nightStake && this.alive.includes(this.nightStake)) {
      const target = this.nightStake;
      if (this.roles.get(target) === "VAMPIRE") {
        this.alive = this.alive.filter(p => p !== target);
        this.sendChannelMessage(`Dawn: ${target} was staked and destroyed — they were a VAMPIRE!`);
      } else {
        this.sendChannelMessage(`Dawn: The slayer staked ${target} but they were not a vampire!`);
        const slayer = [...this.roles.entries()].find(([, r]) => r === "SLAYER")?.[0];
        if (slayer) this.alive = this.alive.filter(p => p !== slayer);
      }
    } else {
      this.sendChannelMessage("Dawn: the night passed quietly.");
    }

    const over = await this.checkWinCondition();
    if (!over) this.startDay();
  }

  private async checkWinCondition(): Promise<boolean> {
    const vamps  = this.alive.filter(p => this.roles.get(p) === "VAMPIRE");
    const humans = this.alive.filter(p => this.roles.get(p) !== "VAMPIRE");
    const tax    = Math.round(this.totalPot * HOUSE_TAX_RATE);
    const pot    = this.totalPot - tax;

    if (vamps.length === 0) {
      const share = humans.length > 0 ? Math.round(pot / humans.length) : 0;
      for (const h of humans) {
        if (share > 0) await this.creditUser(h, share).catch(() => {});
      }
      this.sendChannelMessage(
        `HUMANS WIN! All vampires destroyed. [${humans.join(", ")}] survive` +
        (share > 0 ? ` — IDR ${fmt(share)} each (after ${fmt(tax)} IDR tax)` : "") +
        ". Enter !start to play again"
      );
      this.resetGame();
      return true;
    }

    if (vamps.length >= humans.length) {
      const share = vamps.length > 0 ? Math.round(pot / vamps.length) : 0;
      for (const v of vamps) {
        if (share > 0) await this.creditUser(v, share).catch(() => {});
      }
      this.sendChannelMessage(
        `VAMPIRES WIN! [${vamps.join(", ")}]` +
        (share > 0 ? ` — IDR ${fmt(share)} each (after ${fmt(tax)} IDR tax)` : "") +
        ". Enter !start to play again"
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
    this.nightBite  = null;
    this.nightStake = null;
    this.totalPot   = 0;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "vampire",
  displayName: "Vampire",
  description: "Game sosial Vampir vs Van Helsing — bertahan atau serang!",
  category: "social",
  factory: ctx => new Vampire(ctx),
});
