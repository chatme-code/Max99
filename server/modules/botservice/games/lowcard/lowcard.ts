import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";
import { Card, Rank } from "../common/card";
import { storage } from "../../../../storage";

// House tax rate applied to the LowCard winner's payout.
// e.g. 0.10 = 10% — winning a 10,000 IDR pot pays out 9,000 IDR (1,000 tax).
const HOUSE_TAX_RATE = 0.10;

export class LowCard extends BotBase {
  readonly gameType = "lowcard";

  private readonly minPlayers:     number;
  private readonly timeToJoinMs:   number;
  private readonly timeToDrawMs:   number;
  private readonly timeNewRoundMs: number;
  private readonly confirmMs:      number;
  private readonly idleMs:         number;
  private readonly defaultAmount:  number;
  private readonly maxAmount:      number;

  private amountJoinPot = 0;
  private totalPot      = 0;

  private players      = new Map<string, Card | null>();
  private charged      = new Set<string>();
  private tiebreakers  = new Map<string, Card | null>();
  private isTiebreaker  = false;
  private isRoundStarted = false;
  private deck: Card[] = [];
  private round = 0;
  private gameStarter: string | null = null;

  private confirmTimer: NodeJS.Timeout | null = null;
  private joinTimer:    NodeJS.Timeout | null = null;
  private drawTimer:    NodeJS.Timeout | null = null;

  private lastActivity = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers     = this.param("MinPlayers",            2);
    this.timeToJoinMs   = this.param("timerJoinGame",     30_000);
    this.timeToDrawMs   = this.param("timerDraw",         20_000);
    this.timeNewRoundMs = this.param("timerNewRound",      3_000);
    this.confirmMs      = this.param("timerChargeConfirm", 5_000);
    this.idleMs         = this.param("timerIdle",     30 * 60_000);
    this.defaultAmount  = this.param("amountJoinPot",          500);
    this.maxAmount      = this.param("maxAmountJoinPot",   999_999_999);
    this.amountJoinPot  = this.defaultAmount;

    this.sendChannelMessage(`Bot ${this.botDisplayName} added to room by ${this.starterUsername}`);
    this.sendChannelMessage(
      this.amountJoinPot > 0
        ? `Play now: !start to enter. Cost: IDR ${this.amountJoinPot}. For custom entry, !start <entry_amount> `
        : `Play LowCard: !start. Need ${this.minPlayers} players.`
    );
    this.updateActivity();
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME && Date.now() - this.lastActivity > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state === BotState.NO_GAME;
  }

  stopBot(): void {
    this.clearMyTimers();
    if (this.charged.size > 0) {
      this.sendChannelMessage(`Sorry, the game has been canceled. Don't worry, your credit has been returned`);
      this.refundAll().catch(() => {});
    } else if (this.players.size > 0) {
      this.refundAll().catch(() => {});
    }
    this.resetGame();
    this.sendChannelMessage(`bot ${this.botDisplayName} has been stopped`);
  }

  onUserJoinChannel(username: string): void {
    this.sendMessage(
      `[PVT] ${this.botDisplayName} is Running! !start to start a game. !j to join game. Amount = ${this.amountJoinPot} IDR`,
      username
    );
  }

  onUserLeaveChannel(username: string): void {
    if (!this.players.has(username) || this.state === BotState.NO_GAME) return;

    const wasCharged = this.charged.has(username);
    this.players.delete(username);
    this.tiebreakers.delete(username);
    this.charged.delete(username);

    if (wasCharged) this.refundUser(username, this.amountJoinPot).catch(() => {});

    this.sendChannelMessage(`${username} left the game`);

    if (this.state === BotState.PLAYING && this.players.size < this.minPlayers) {
      this.clearDrawTimer();
      this.pickWinner().catch(() => {});
    }
  }

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.trim();
    if (msg.toLowerCase() === "!n") { this.cmdNo(username); return; }
    if (msg.toLowerCase().startsWith("!start")) { this.cmdStart(username, msg).catch(e => console.error("[lowcard]", e)); return; }
    if (msg.toLowerCase() === "!j") { this.cmdJoin(username); return; }
    if (msg.toLowerCase().startsWith("!d")) {
      if (this.state === BotState.PLAYING && this.isRoundStarted) {
        if (!this.players.has(username)) {
          this.sendMessage(`${username}: you're not in the game.`, username);
          return;
        }
        if (this.isTiebreaker && !this.tiebreakers.has(username)) {
          this.sendMessage(`${username}: Only tied players can draw now. Please wait... `, username);
          return;
        }
        this.draw(username, false);
      } else {
        this.sendMessage(`${username}: Invalid command.`, username);
      }
    }
  }

  // ─── !start ──────────────────────────────────────────────────────────────────

  private async cmdStart(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendGameCannotStartMessage(username);
      return;
    }
    const parts = msg.trim().split(/\s+/);
    if (parts.length > 1) {
      const parameter = parts[1];
      if (!this.checkJoinPotParameter(parameter, username)) return;
    }
    if (this.amountJoinPot > 0 && !(await this.userCanAfford(username, this.amountJoinPot))) return;

    this.gameStarter = username;
    this.startGame(username);
  }

  private sendGameCannotStartMessage(username: string): void {
    let message: string;
    if (this.state === BotState.GAME_JOINING) {
      message = `${username}: A game is on. !j to join. Charges may apply.`;
    } else if (
      this.state === BotState.GAME_STARTING ||
      this.state === BotState.PLAYING
    ) {
      message = `${username}: A game is currently on.`;
    } else {
      message = `Sorry, new game cannot be started now.`;
    }
    this.sendMessage(message, username);
  }

  private startGame(username: string): void {
    this.updateActivity();
    if (this.amountJoinPot > 0) {
      const message =
        `${username}: Charges apply. IDR ${this.amountJoinPot} Create/enter pot.` +
        ` !n to cancel. ${Math.round(this.confirmMs / 1000)} seconds`;
      this.state = BotState.GAME_STARTING;
      this.sendMessage(message, username);
      this.confirmTimer = setTimeout(() => this.startJoining(), this.confirmMs);
    } else {
      this.state = BotState.GAME_STARTING;
      this.startJoining();
    }
  }

  private startJoining(): void {
    this.confirmTimer = null;
    const starter = this.gameStarter!;

    this.state = BotState.GAME_JOINING;
    this.addPlayer(starter);

    const sec = Math.round(this.timeToJoinMs / 1000);
    this.sendChannelMessage(
      this.amountJoinPot > 0
        ? `LowCard started by ${starter}. !j to join. Cost IDR ${this.amountJoinPot}. ${sec} seconds`
        : `LowCard started by ${starter}. !j to join. ${sec} seconds`
    );

    this.joinTimer = setTimeout(() => this.beginPlay(), this.timeToJoinMs);
  }

  // ─── !j ──────────────────────────────────────────────────────────────────────

  private cmdJoin(username: string): void {
    if (!this.players.has(username)) {
      if (this.state === BotState.GAME_JOINING) {
        this.addPlayer(username);
      } else if (this.state === BotState.PLAYING) {
        this.sendMessage(`${username}: Sorry, a game has already started.`, username);
      } else {
        this.sendMessage(`${username}: Invalid command.`, username);
      }
    } else {
      this.sendMessage(`${username}: You are already added to game.`, username);
    }
  }

  private addPlayer(username: string): void {
    if (this.state === BotState.GAME_JOINING) {
      if (!this.players.has(username)) {
        this.players.set(username, null);
      }
      let message = `${username}: added to game.`;
      if (this.amountJoinPot > 0) {
        message += `Charges apply. IDR ${this.amountJoinPot}`;
      }
      this.sendMessage(message, username);
      if (username !== this.gameStarter) {
        this.sendChannelMessage(`${username} joined the game.`);
      }
    }
  }

  // ─── !n ──────────────────────────────────────────────────────────────────────

  private cmdNo(username: string): void {
    if (this.state === BotState.GAME_STARTING && username === this.gameStarter && this.amountJoinPot > 0) {
      if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
      this.state = BotState.NO_GAME;
      this.amountJoinPot = this.defaultAmount;
      this.gameStarter = null;
      this.sendMessage(`${username}: You were not charged.`, username);
    } else {
      this.sendMessage(`${username}: Invalid command.`, username);
    }
  }

  // ─── Begin Play ───────────────────────────────────────────────────────────────

  private async beginPlay(): Promise<void> {
    this.joinTimer = null;
    if (this.players.size < this.minPlayers) {
      this.sendChannelMessage(`Joining ends. Not enough players. Need ${this.minPlayers}.`);
      this.resetGame();
      return;
    }

    const toRemove: string[] = [];
    for (const [player] of this.players) {
      if (this.amountJoinPot > 0) {
        const canAfford = await this.userCanAffordSilent(player);
        if (canAfford) {
          await this.chargeUser(player, this.amountJoinPot).catch(() => {});
          this.charged.add(player);
          this.totalPot += this.amountJoinPot;
        } else {
          toRemove.push(player);
          this.sendMessage(`${player}: Sorry, insufficient funds to join pot.`, player);
        }
      }
    }
    for (const p of toRemove) this.players.delete(p);

    if (this.players.size < this.minPlayers) {
      this.resetGame();
      return;
    }

    try {
      this.sendChannelMessage("Game begins - Lowest card is OUT!");
      this.state = BotState.PLAYING;
      this.deck = Card.newShuffledDeck();
      this.newRound();
    } catch {
      this.sendChannelMessage("Billing error. Game canceled. No charges");
      this.state = BotState.NO_GAME;
    }
  }

  // ─── Round Logic ──────────────────────────────────────────────────────────────

  private newRound(): void {
    if (this.players.size > 1) {
      this.isRoundStarted = true;
      this.round++;
      this.updateActivity();

      // Reset all card hands (keep player lists as-is)
      for (const [p] of this.tiebreakers) this.tiebreakers.set(p, null);
      for (const [p] of this.players) this.players.set(p, null);
      this.deck = Card.newShuffledDeck();

      const timeSec = Math.round(this.timeToDrawMs / 1000);
      this.sendChannelMessage(`ROUND #${this.round}: Players, !d to DRAW. ${timeSec} seconds.`);

      const roundNum = this.round;
      this.drawTimer = setTimeout(() => {
        this.sendChannelMessage("TIME'S UP! Tallying cards...");
        this.tallyDraws(roundNum);
      }, this.timeToDrawMs);
    }
  }

  private draw(username: string, auto: boolean): void {
    const currentHands = this.isTiebreaker ? this.tiebreakers : this.players;
    const currentCard = currentHands.get(username);
    if (currentCard !== null && currentCard !== undefined) {
      if (!auto) this.sendMessage(`${username}: you already drew.`, username);
      return;
    }
    if (this.deck.length === 0) this.deck = Card.newShuffledDeck();
    const card = this.deck.pop()!;
    currentHands.set(username, card);

    this.sendChannelMessage(
      auto
        ? `Bot draws - ${username}: ${card.toEmoticonHotkey()}`
        : `${username}: ${card.toEmoticonHotkey()}`
    );

    if (!auto) {
      for (const [, c] of currentHands) {
        if (c === null) return;
      }
      this.clearDrawTimer();
      this.tallyDraws(this.round);
    }
  }

  private tallyDraws(roundNum: number): void {
    if (this.round !== roundNum) return;
    this.clearDrawTimer();
    this.isRoundStarted = false;

    const currentHands = this.isTiebreaker ? this.tiebreakers : this.players;

    // Auto-draw for anyone who hasn't drawn yet
    for (const [p, c] of currentHands) {
      if (c === null) this.draw(p, true);
    }

    // Build sorted list of (player, card) for active group
    const drawn = [...currentHands.entries()]
      .map(([p, c]) => ({ player: p, card: c! }))
      .filter(r => r.card !== null)
      .sort((a, b) => Rank.getRankOrder(a.card.rank()) - Rank.getRankOrder(b.card.rank()));

    if (drawn.length === 0) { this.pickWinner().catch(() => {}); return; }

    const minRank  = Rank.getRankOrder(drawn[0].card.rank());
    const losers   = drawn.filter(r => Rank.getRankOrder(r.card.rank()) === minRank);

    if (losers.length === 1) {
      // One clear loser
      const loser = losers[0];
      const wasTiebreaker = this.isTiebreaker;
      this.players.delete(loser.player);
      this.charged.delete(loser.player);
      this.tiebreakers.clear();
      this.isTiebreaker = false;

      this.sendChannelMessage(
        wasTiebreaker
          ? `Tie broken! ${loser.player}: OUT with the lowest card! ${loser.card.toEmoticonHotkey()}`
          : `${loser.player}: OUT with the lowest card! ${loser.card.toEmoticonHotkey()}`
      );

      if (this.players.size < this.minPlayers) {
        this.pickWinner().catch(() => {});
        return;
      }

      this.isTiebreaker = false;
      const playerList = [...this.players.keys()].join(", ");
      this.sendChannelMessage(`Players are (${this.players.size}): ${playerList}`);
      this.sendChannelMessage(`All players,  next round in ${Math.round(this.timeNewRoundMs / 1000)} seconds!`);
      this.drawTimer = setTimeout(() => this.newRound(), this.timeNewRoundMs);

    } else {
      // Multiple lowest — tiebreaker round
      this.tiebreakers.clear();
      for (const l of losers) this.tiebreakers.set(l.player, null);
      this.isTiebreaker = true;

      const tiebreakerList = [...this.tiebreakers.keys()].join(", ");
      this.sendChannelMessage(`Tied players(${this.tiebreakers.size}): ${tiebreakerList}`);
      this.sendChannelMessage(`Tied players ONLY draw again. Next round in ${Math.round(this.timeNewRoundMs / 1000)} seconds!`);
      this.drawTimer = setTimeout(() => this.newRound(), this.timeNewRoundMs);
    }
  }

  // ─── Winner ───────────────────────────────────────────────────────────────────

  private async pickWinner(): Promise<void> {
    if (this.state !== BotState.PLAYING) return;

    const winner = this.players.size > 0 ? [...this.players.keys()][0] : null;

    if (winner) {
      if (this.totalPot > 0) {
        // Apply 10% house tax — winner receives pot minus tax.
        // e.g. pot 10,000 → tax 1,000 → payout 9,000 IDR.
        const tax    = Math.round(this.totalPot * HOUSE_TAX_RATE);
        const payout = this.totalPot - tax;
        await this.creditUser(winner, payout).catch(() => {});
        this.sendChannelMessage(
          `Game over! ${winner} WINS IDR ${payout}!! CONGRATS!`
        );
      } else {
        this.sendChannelMessage(`Game over! ${winner} wins!! CONGRATS!`);
      }
    }

    const nextAmount = this.amountJoinPot;
    this.resetGame();
    this.updateActivity();
    this.sendChannelMessage(
      nextAmount > 0
        ? `Play now: !start to enter. Cost: IDR ${nextAmount}. For custom entry, !start <entry_amount>`
        : `Play LowCard: !start. Need ${this.minPlayers} players.`
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private checkJoinPotParameter(parameter: string, username: string): boolean {
    try {
      const amount = parseFloat(parameter);
      if (amount >= this.amountJoinPot) {
        if (amount > this.maxAmount) {
          this.sendMessage(`Maximum bet is ${this.maxAmount}`, username);
          return false;
        }
        this.amountJoinPot = amount;
        return true;
      } else {
        this.sendMessage(`PLAYER: ${parameter} invalid. Game not started.`, username);
        return false;
      }
    } catch {
      this.sendChannelMessage(`PLAYER: ${parameter} invalid. Game not started.`);
      return false;
    }
  }

  private async userCanAffordSilent(username: string): Promise<boolean> {
    if (this.amountJoinPot <= 0) return true;
    try {
      const acct = await storage.getCreditAccount(username);
      return acct.balance >= this.amountJoinPot;
    } catch { return false; }
  }

  private async refundAll(): Promise<void> {
    for (const player of this.charged) {
      await this.refundUser(player, this.amountJoinPot).catch(() => {});
    }
  }

  private clearDrawTimer(): void {
    if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = null; }
  }

  private clearMyTimers(): void {
    this.clearDrawTimer();
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
    if (this.joinTimer)    { clearTimeout(this.joinTimer);    this.joinTimer    = null; }
  }

  private resetGame(): void {
    this.clearMyTimers();
    this.players.clear();
    this.charged.clear();
    this.tiebreakers.clear();
    this.isTiebreaker   = false;
    this.isRoundStarted = false;
    this.deck           = [];
    this.round          = 0;
    this.totalPot       = 0;
    this.gameStarter    = null;
    this.amountJoinPot  = this.defaultAmount;
    this.state          = BotState.NO_GAME;
  }

  private updateActivity(): void {
    this.lastActivity = Date.now();
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "lowcard",
  displayName: "Low Card",
  description: "Kartu terendah menang — strategi dan sedikit keberuntungan.",
  category: "gambling",
  factory: ctx => new LowCard(ctx),
});
