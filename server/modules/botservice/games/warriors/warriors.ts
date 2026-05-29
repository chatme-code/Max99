import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function fmt(n: number): string { return n.toFixed(2); }

interface Warrior {
  hp: number;
  maxHp: number;
  attack: number;
  defense: number;
  lastAction: "ATTACK" | "DEFEND" | "MAGIC" | null;
}

export class Warriors extends BotBase {
  readonly gameType = "warriors";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private roundTimeMs:     number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;
  private startHp:         number;
  private baseAttack:      number;
  private baseDefense:     number;
  private magicCooldown:   number;

  private costToJoin = 0;
  private warriors = new Map<string, Warrior>();
  private magicLastUsed = new Map<string, number>();
  private targets = new Map<string, string>();
  private round = 0;
  private waitTimer:  NodeJS.Timeout | null = null;
  private roundTimer: NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.maxPlayers      = this.param("MaxPlayers", 8);
    this.waitForPlayerMs = this.param("TimeToJoinGame", 60_000);
    this.roundTimeMs     = this.param("RoundTime", 20_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 500);
    this.startHp         = this.param("StartHP", 100);
    this.baseAttack      = this.param("BaseAttack", 20);
    this.baseDefense     = this.param("BaseDefense", 10);
    this.magicCooldown   = this.param("MagicCooldown", 3);

    this.sendChannelMessage(
      `Bot Warriors added. !start to play. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      "Commands: !a <player>=attack, !d=defend, !m <player>=magic"
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
        this.sendMessage(`Play Warriors. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`Warriors forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("Warriors battle in progress. Wait for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(username: string): void {
    if (this.warriors.has(username) && this.state !== BotState.NO_GAME) {
      this.warriors.delete(username);
      this.refundUser(username, this.costToJoin).catch(() => {});
      this.sendChannelMessage(`${username} fled the battle`);
    }
  }

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.trim();
    const lower = msg.toLowerCase();
    if (lower.startsWith("!start")) { this.startNewGame(username, lower).catch(e => console.error("[warriors]", e)); return; }
    if (lower === "!j") { this.joinGame(username).catch(e => console.error("[warriors]", e)); return; }
    if (lower.startsWith("!a ")) { this.doAttack(username, msg.slice(3).trim()); return; }
    if (lower === "!d") { this.doDefend(username); return; }
    if (lower.startsWith("!m ")) { this.doMagic(username, msg.slice(3).trim()); return; }
    if (lower === "!hp") { this.showStatus(username); return; }
    this.sendMessage("Commands: !a <player>=attack, !d=defend, !m <player>=magic, !hp=status", username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `Warriors forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`
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
    this.warriors.clear();
    this.targets.clear();
    this.magicLastUsed.clear();
    this.round = 0;
    this.warriors.set(username, this.newWarrior());
    this.sendChannelMessage(`${username} started Warriors!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Wait for next game", username); return;
    }
    if (this.warriors.has(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.warriors.size >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.warriors.set(username, this.newWarrior());
    this.sendChannelMessage(`${username} joined Warriors`);
  }

  private doAttack(username: string, target: string): void {
    if (!this.inGame(username)) return;
    if (!this.warriors.has(target) || target === username) {
      this.sendMessage(`Invalid target. Players: [${[...this.warriors.keys()].join(", ")}]`, username); return;
    }
    const w = this.warriors.get(username)!;
    w.lastAction = "ATTACK";
    this.targets.set(username, target);
    this.sendChannelMessage(`${username} readies an attack on ${target}!`);
  }

  private doDefend(username: string): void {
    if (!this.inGame(username)) return;
    const w = this.warriors.get(username)!;
    w.lastAction = "DEFEND";
    this.sendChannelMessage(`${username} takes a defensive stance!`);
  }

  private doMagic(username: string, target: string): void {
    if (!this.inGame(username)) return;
    if (!this.warriors.has(target) || target === username) {
      this.sendMessage(`Invalid target. Players: [${[...this.warriors.keys()].join(", ")}]`, username); return;
    }
    const lastUsed = this.magicLastUsed.get(username) ?? 0;
    if (this.round - lastUsed < this.magicCooldown) {
      this.sendMessage(`Magic on cooldown for ${this.magicCooldown - (this.round - lastUsed)} more rounds`, username); return;
    }
    const w = this.warriors.get(username)!;
    w.lastAction = "MAGIC";
    this.targets.set(username, target);
    this.magicLastUsed.set(username, this.round);
    this.sendChannelMessage(`${username} channels magic towards ${target}!`);
  }

  private showStatus(username: string): void {
    const parts: string[] = [];
    for (const [p, w] of this.warriors) {
      parts.push(`${p}: ${w.hp}/${w.maxHp}HP`);
    }
    this.sendMessage(`Status: ${parts.join(" | ")}`, username);
  }

  private inGame(username: string): boolean {
    if (this.state !== BotState.PLAYING) { this.sendMessage("No active game", username); return false; }
    if (!this.warriors.has(username)) { this.sendMessage("You are not in the game", username); return false; }
    return true;
  }

  private newWarrior(): Warrior {
    return {
      hp: this.startHp,
      maxHp: this.startHp,
      attack: this.baseAttack,
      defense: this.baseDefense,
      lastAction: null,
    };
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
    if (this.warriors.size < this.minPlayers) {
      await this.refundAll();
      this.resetGame();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.state = BotState.PLAYING;
    const playerList = [...this.warriors.keys()].join(", ");
    this.sendChannelMessage(
      `Warriors battle begins! [${playerList}]. ` +
      `!a <player>=attack, !d=defend, !m <player>=magic. !hp for status.`
    );
    this.startRound();
  }

  private startRound(): void {
    this.round++;
    for (const w of this.warriors.values()) {
      w.lastAction = null;
    }
    this.targets.clear();
    this.sendChannelMessage(
      `Round ${this.round}! Active: [${[...this.warriors.keys()].join(", ")}]. ` +
      `${Math.round(this.roundTimeMs / 1000)}s to act.`
    );
    this.roundTimer = setTimeout(() => this.resolveRound(), this.roundTimeMs);
  }

  private async resolveRound(): Promise<void> {
    this.roundTimer = null;
    const dead: string[] = [];

    for (const [attacker, w] of this.warriors) {
      if (w.lastAction === null) {
        w.lastAction = "DEFEND";
        this.sendChannelMessage(`${attacker} was idle — auto-defending`);
      }
    }

    for (const [attacker, w] of this.warriors) {
      const target = this.targets.get(attacker);
      if ((w.lastAction === "ATTACK" || w.lastAction === "MAGIC") && target && this.warriors.has(target)) {
        const defender = this.warriors.get(target)!;
        const isMagic = w.lastAction === "MAGIC";
        const atkRoll = rand(w.attack, w.attack * 2) + (isMagic ? rand(10, 30) : 0);
        const isDefending = defender.lastAction === "DEFEND";
        const defRoll = isDefending ? rand(defender.defense, defender.defense * 2) : rand(0, defender.defense);
        const dmg = Math.max(0, atkRoll - defRoll);
        defender.hp -= dmg;
        const type = isMagic ? "casts magic on" : "attacks";
        this.sendChannelMessage(
          `${attacker} ${type} ${target} for ${dmg} dmg. ` +
          `${target} HP: ${Math.max(0, defender.hp)}/${defender.maxHp}`
        );
        if (defender.hp <= 0 && !dead.includes(target)) dead.push(target);
      }
    }

    for (const fallen of dead) {
      this.warriors.delete(fallen);
      this.targets.delete(fallen);
      this.sendChannelMessage(`${fallen} has been defeated!`);
    }

    if (this.warriors.size <= 1) {
      await this.endGame();
      return;
    }

    this.sendChannelMessage(`${this.warriors.size} warriors left. Next round in 3s...`);
    this.roundTimer = setTimeout(() => this.startRound(), 3_000);
  }

  private async endGame(): Promise<void> {
    const survivors = [...this.warriors.keys()];
    if (survivors.length === 0) {
      this.sendChannelMessage("All warriors fell! No winner. Enter !start to play again");
    } else {
      const winner = survivors[0];
      const pot = this.warriors.size > 0 ? this.warriors.size * this.costToJoin : this.costToJoin;
      if (pot > 0) await this.refundUser(winner, pot).catch(() => {});
      this.sendChannelMessage(
        `${winner} wins the battle${pot > 0 ? ` — ${fmt(pot)} credits` : ""}! Enter !start to play again`
      );
    }
    this.resetGame();
  }

  private async refundAll(): Promise<void> {
    for (const player of this.warriors.keys()) {
      if (this.costToJoin > 0) await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.warriors.clear();
    this.targets.clear();
    this.magicLastUsed.clear();
    this.round = 0;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "warriors",
  displayName: "Warriors",
  description: "Pertarungan pejuang — pilih senjata dan kalahkan lawan!",
  category: "sports",
  factory: ctx => new Warriors(ctx),
});
