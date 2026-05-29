import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";
import { Card, Hand, newShuffledDeck } from "./hand";

type Bet = "UNKNOWN" | "PLAYER" | "BANKER";

const HOUSE_TAX_RATE = 0.10;

function fmtIDR(n: number): string {
  return `IDR ${Math.round(n)}`;
}

export class Baccarat extends BotBase {
  readonly gameType = "baccarat";

  private minPlayers:      number;
  private waitForPlayerMs: number;
  private placeBetMs:      number;
  private drawCardMs:      number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;

  private deck:       Card[] | null = null;
  private bankerHand: Hand = new Hand();
  private playerHand: Hand = new Hand();
  private playerBets  = new Map<string, Bet>();
  private round       = 1;
  private costToJoin  = 0;
  private totalPot    = 0;
  private timeLastGameFinished = Date.now();

  private waitTimer:  NodeJS.Timeout | null = null;
  private betTimer:   NodeJS.Timeout | null = null;
  private drawTimer:  NodeJS.Timeout | null = null;

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.waitForPlayerMs = this.param("WaitForPlayerInterval", 30_000);
    this.placeBetMs      = this.param("PlaceBetInterval", 20_000);
    this.drawCardMs      = this.param("DrawCardInterval", 5_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame",  500);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 50_000);

    this.sendChannelMessage(
      `Bot Baccarat added to the room. Enter !start to start a game. ` +
      `${fmtIDR(this.minCostToJoin)}. For custom entry, !start <entry_amount>`
    );
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
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          `Play Baccarat. Enter !start to start a game. ${fmtIDR(this.minCostToJoin)}. ` +
          `For custom entry, !start <entry_amount>`,
          username
        );
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Play Baccarat. Enter !j to join the game. ${fmtIDR(this.costToJoin)}`,
          username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("Baccarat is on now. Get ready for next game", username);
        break;
    }
  }

  onUserLeaveChannel(username: string): void {
    if (this.playerBets.has(username) && this.state !== BotState.NO_GAME) {
      this.playerBets.delete(username);
      this.sendChannelMessage(`${username} left the game`);
    }
  }

  onMessage(username: string, text: string, ts: number): void {
    const msg = text.toLowerCase().trim();
    if (msg.startsWith("!start")) { this.startNewGame(username, msg).catch(e => console.error("[baccarat]", e)); return; }
    if (msg === "!j")             { this.joinGame(username).catch(e => console.error("[baccarat]", e));           return; }
    if (msg === "!p")             { this.placeBet(username, "PLAYER"); return; }
    if (msg === "!b")             { this.placeBet(username, "BANKER"); return; }
    this.sendMessage(`${text} is not a valid command`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME: {
        const parts = msg.trim().split(/\s+/);
        let cost = this.minCostToJoin;
        if (parts.length > 1) {
          const parsed = parseFloat(parts[1]);
          if (isNaN(parsed)) {
            this.sendMessage(`${parts[1]} is not a valid amount`, username); return;
          }
          if (parsed < this.minCostToJoin) {
            this.sendMessage(`Minimum amount to start a game is ${fmtIDR(this.minCostToJoin)}`, username); return;
          }
          if (parsed > this.maxCostToJoin) {
            this.sendMessage(`Maximum bet is ${fmtIDR(this.maxCostToJoin)}`, username); return;
          }
          cost = parsed;
        }
        if (!(await this.userCanAfford(username, cost))) return;
        await this.chargeUser(username, cost);
        this.costToJoin = cost;
        this.totalPot   = cost;
        this.round      = 1;
        this.bankerHand.clear();
        this.playerHand.clear();
        this.playerBets.clear();
        this.playerBets.set(username, "UNKNOWN");
        this.sendChannelMessage(`${username} started a new game`);
        this.waitForMorePlayers();
        break;
      }
      case BotState.GAME_JOINING:
        this.sendMessage(`Enter !j to join the game. ${fmtIDR(this.costToJoin)}`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("A game is currently in progress. Please wait for next game", username);
        break;
    }
  }

  private async joinGame(username: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          `Enter !start to start a game. ${fmtIDR(this.minCostToJoin)}. For custom entry, !start <entry_amount>`,
          username
        );
        break;
      case BotState.GAME_JOINING: {
        if (this.playerBets.has(username)) {
          this.sendMessage("You have already joined the game. Please wait for the game to start", username); return;
        }
        if (!(await this.userCanAfford(username, this.costToJoin))) return;
        await this.chargeUser(username, this.costToJoin);
        this.totalPot += this.costToJoin;
        this.playerBets.set(username, "UNKNOWN");
        this.sendChannelMessage(`${username} joined the game`);
        break;
      }
      case BotState.PLAYING:
        this.sendMessage("A game is currently in progress. Please wait for next game", username);
        break;
    }
  }

  private placeBet(username: string, bet: Bet): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage("Enter !start to start a game", username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage("Game starting soon! Please wait", username);
        break;
      case BotState.PLAYING: {
        const existing = this.playerBets.get(username);
        if (existing === undefined) {
          this.sendMessage("A game is currently in progress. Please wait for next game", username); return;
        }
        if (existing === "UNKNOWN") {
          this.playerBets.set(username, bet);
          this.sendMessage(`You have chosen ${bet}`, username);
        } else {
          this.sendMessage(`You have already chosen ${existing}`, username);
        }
        break;
      }
    }
  }

  private waitForMorePlayers(): void {
    this.sendChannelMessage(
      `Waiting for more players. Enter !j to join the game. ${fmtIDR(this.costToJoin)}`
    );
    this.state     = BotState.GAME_JOINING;
    this.waitTimer = setTimeout(() => this.chargeAndCountPlayers(), this.waitForPlayerMs);
  }

  private chargeAndCountPlayers(): void {
    this.waitTimer = null;
    if (this.playerBets.size < this.minPlayers) {
      this.refundAll().then(() => {
        this.endGame();
        this.sendChannelMessage("Not enough players joined the game. Enter !start to start a new game");
      }).catch(() => {});
      return;
    }
    this.waitForPlacingBets();
  }

  private waitForPlacingBets(): void {
    const sec = Math.round(this.placeBetMs / 1000);
    this.sendChannelMessage(
      `Round ${this.round++}. Dealing cards in ${sec} seconds. !p for PLAYER or !b for BANKER`
    );
    this.state    = BotState.PLAYING;
    this.betTimer = setTimeout(() => {
      this.placeBetsForLazyPlayers();
      this.dealCards();
    }, this.placeBetMs);
  }

  private placeBetsForLazyPlayers(): void {
    const players: string[] = [];
    const bankers:  string[] = [];
    for (const [username, bet] of this.playerBets) {
      let finalBet = bet;
      if (bet === "UNKNOWN") {
        finalBet = Math.random() < 0.5 ? "PLAYER" : "BANKER";
        this.playerBets.set(username, finalBet);
        this.sendMessage(`You did not make a choice. Bot chose ${finalBet} for you`, username);
      }
      if (finalBet === "PLAYER") players.push(username);
      else bankers.push(username);
    }
    this.sendChannelMessage(`PLAYER [${players.join(", ")}] BANKER [${bankers.join(", ")}]`);
  }

  private dealCards(): void {
    this.betTimer = null;
    if (!this.deck || this.deck.length < 7) {
      this.deck = newShuffledDeck();
    }
    for (let i = 0; i < 2; i++) {
      this.playerHand.add(this.deck.shift()!);
      this.bankerHand.add(this.deck.shift()!);
    }
    const playerCount = this.playerHand.count();
    const bankerCount = this.bankerHand.count();
    this.sendChannelMessage(`PLAYER: ${this.playerHand}. BANKER: ${this.bankerHand}`);

    if (playerCount >= 8 || bankerCount >= 8) {
      this.tallyUp();
    } else if (playerCount <= 5) {
      this.drawTimer = setTimeout(() => this.drawThirdCardForPlayer(), this.drawCardMs);
    } else if (bankerCount <= 5) {
      this.drawTimer = setTimeout(() => this.drawThirdCardForBanker(), this.drawCardMs);
    } else {
      this.drawTimer = setTimeout(() => this.tallyUp(), this.drawCardMs);
    }
  }

  private drawThirdCardForPlayer(): void {
    const thirdCard = this.deck!.shift()!;
    this.playerHand.add(thirdCard);
    this.sendChannelMessage(`PLAYER drew third card. ${this.playerHand}`);
    if (this.bankerNeedsThirdCard(thirdCard)) {
      this.drawTimer = setTimeout(() => this.drawThirdCardForBanker(), this.drawCardMs);
    } else {
      this.drawTimer = setTimeout(() => this.tallyUp(), this.drawCardMs);
    }
  }

  private drawThirdCardForBanker(): void {
    this.bankerHand.add(this.deck!.shift()!);
    this.sendChannelMessage(`BANKER drew third card. ${this.bankerHand}`);
    this.drawTimer = setTimeout(() => this.tallyUp(), this.drawCardMs);
  }

  private bankerNeedsThirdCard(playerThirdCard: Card): boolean {
    const bankerCount = this.bankerHand.count();
    switch (playerThirdCard.rank()) {
      case "2": case "3": return bankerCount <= 4;
      case "4": case "5": return bankerCount <= 5;
      case "6": case "7": return bankerCount <= 6;
      case "8":           return bankerCount <= 2;
      case "9": case "T": case "J": case "Q": case "K": case "A":
                          return bankerCount <= 3;
    }
    return false;
  }

  private tallyUp(): void {
    this.drawTimer = null;
    const players: string[] = [];
    const bankers:  string[] = [];
    for (const [username, bet] of this.playerBets) {
      if (bet === "PLAYER") players.push(username);
      else bankers.push(username);
      this.playerBets.set(username, "UNKNOWN");
    }

    const playerCount = this.playerHand.count();
    const bankerCount = this.bankerHand.count();
    let losers: string[];

    if (playerCount > bankerCount) {
      this.sendChannelMessage(`PLAYER wins! ${this.playerHand}`);
      losers = bankers;
    } else if (playerCount < bankerCount) {
      this.sendChannelMessage(`BANKER wins! ${this.bankerHand}`);
      losers = players;
    } else {
      this.sendChannelMessage(`TIE! BANKER and PLAYER on ${playerCount}`);
      losers = [];
    }

    if (losers.length !== this.playerBets.size) {
      for (const loser of losers) {
        this.playerBets.delete(loser);
      }
    }

    if (this.playerBets.size === 0) {
      this.endGame();
      this.sendChannelMessage("No more players left in the game. Enter !start to start a new game");
    } else if (this.playerBets.size === 1) {
      const winner = [...this.playerBets.keys()][0];
      const tax = Math.round(this.totalPot * HOUSE_TAX_RATE * 100) / 100;
      const payout = Math.round((this.totalPot - tax) * 100) / 100;
      this.endGame();
      this.creditUser(winner, payout).catch(() => {});
      this.sendChannelMessage(
        `${winner} won ${fmtIDR(payout)} after ${fmtIDR(tax)} tax! ` +
        `Enter !start to start a game. ${fmtIDR(this.minCostToJoin)}. ` +
        `For custom entry, !start <entry_amount>`
      );
    } else {
      const remaining = [...this.playerBets.keys()].join(", ");
      this.sendChannelMessage(
        `${this.playerBets.size} players left in the game [${remaining}]`
      );
      this.playerHand.clear();
      this.bankerHand.clear();
      this.waitForPlacingBets();
    }
  }

  private async refundAll(): Promise<void> {
    for (const [player] of this.playerBets) {
      await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private endGame(): void {
    this.clearTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.playerBets.clear();
  }

  private clearTimers(): void {
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
    if (this.betTimer)  { clearTimeout(this.betTimer);  this.betTimer  = null; }
    if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = null; }
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "baccarat",
  displayName: "Baccarat",
  description: "Game kartu klasik — Banker vs Player.",
  category: "gambling",
  factory: ctx => new Baccarat(ctx),
});
