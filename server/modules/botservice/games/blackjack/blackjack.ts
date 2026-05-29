import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";
import { Card, Hand, newShuffledDeck } from "./hand";

type Decision = "HIT" | "STAND";

function fmt(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(2); }

export class Blackjack extends BotBase {
  readonly gameType = "blackjack";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private decisionMs:      number;
  private dealerPauseMs:   number;
  private idleMs:          number;
  private minCostToJoin:   number;

  private deck:         Card[]              = [];
  private dealerHand:   Hand                = new Hand();
  private playerHands:  Map<string, Hand>   = new Map();
  private playerOrder:  string[]            = [];
  private currentPlayerIdx                  = 0;
  private costToJoin    = 0;
  private totalPot      = 0;
  private round         = 1;
  private timeLastGameFinished = Date.now();

  private decisionTimer: NodeJS.Timeout | null = null;
  private waitTimer:     NodeJS.Timeout | null = null;
  private dealerTimer:   NodeJS.Timeout | null = null;

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.maxPlayers      = this.param("MaxPlayers", 6);
    this.waitForPlayerMs = this.param("WaitForPlayerInterval", 30_000);
    this.decisionMs      = this.param("DecisionInterval", 20_000);
    this.dealerPauseMs   = this.param("RevealDealerCardInterval", 5_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 500);

    this.sendChannelMessage(
      `Bot Blackjack added to the room. Enter !start to start a game. ` +
      `IDR ${fmt(this.minCostToJoin)}. For custom entry, !start <entry_amount>`
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
          `Play Blackjack. Enter !start to start a game. IDR ${fmt(this.minCostToJoin)}. ` +
          `For custom entry, !start <entry_amount>`,
          username
        );
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Play Blackjack. Enter !j to join the game. IDR ${fmt(this.costToJoin)}`,
          username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("Blackjack is on now. Get ready for next game", username);
        break;
    }
  }

  onUserLeaveChannel(username: string): void {
    if (this.playerHands.has(username) && this.state !== BotState.NO_GAME) {
      this.playerHands.delete(username);
      this.sendChannelMessage(`${username} left the game`);
    }
  }

  onMessage(username: string, text: string, ts: number): void {
    const msg = text.toLowerCase().trim();
    if (msg.startsWith("!start")) { this.startNewGame(username, msg).catch(e => console.error("[blackjack]", e));       return; }
    if (msg === "!j")             { this.joinGame(username).catch(e => console.error("[blackjack]", e));                 return; }
    if (msg === "!h")             { this.playerSays(username, "HIT");        return; }
    if (msg === "!s")             { this.playerSays(username, "STAND");      return; }
    this.sendMessage(`${text} is not a valid command`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME: {
        const parts = msg.trim().split(/\s+/);
        let cost = this.minCostToJoin;
        if (parts.length > 1) {
          const parsed = parseFloat(parts[1]);
          if (isNaN(parsed) || parsed <= 0) {
            this.sendMessage(`${parts[1]} is not a valid amount`, username); return;
          }
          if (parsed < this.minCostToJoin) {
            this.sendMessage(`Minimum amount to start a game is IDR ${fmt(this.minCostToJoin)}`, username); return;
          }
          cost = parsed;
        }
        if (!(await this.userCanAfford(username, cost))) return;
        await this.chargeUser(username, cost);
        this.costToJoin = cost;
        this.totalPot   = cost;
        this.round      = 1;
        this.dealerHand.clear();
        this.playerHands.clear();
        this.playerHands.set(username, new Hand());
        this.currentPlayerIdx = 0;
        this.sendChannelMessage(`${username} started a new game`);
        this.waitForMorePlayers();
        break;
      }
      case BotState.GAME_JOINING:
        this.sendMessage(`Enter !j to join the game. IDR ${fmt(this.costToJoin)}`, username);
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
          `Enter !start to start a game. IDR ${fmt(this.minCostToJoin)}. For custom entry, !start <entry_amount>`,
          username
        );
        break;
      case BotState.GAME_JOINING: {
        if (this.playerHands.has(username)) {
          this.sendMessage("You have already joined the game. Please wait for the game to start", username); return;
        }
        if (this.playerHands.size >= this.maxPlayers) {
          this.sendMessage("Game is currently full. Please wait for next game", username); return;
        }
        if (!(await this.userCanAfford(username, this.costToJoin))) return;
        await this.chargeUser(username, this.costToJoin);
        this.totalPot += this.costToJoin;
        this.playerHands.set(username, new Hand());
        this.sendChannelMessage(`${username} joined the game`);
        break;
      }
      case BotState.PLAYING:
        this.sendMessage("A game is currently in progress. Please wait for next game", username);
        break;
    }
  }

  private waitForMorePlayers(): void {
    this.sendChannelMessage(
      `Waiting for more players. Enter !j to join the game. IDR ${fmt(this.costToJoin)}`
    );
    this.state     = BotState.GAME_JOINING;
    this.waitTimer = setTimeout(() => this.chargeAndCountPlayers(), this.waitForPlayerMs);
  }

  private chargeAndCountPlayers(): void {
    this.waitTimer = null;
    if (this.playerHands.size < this.minPlayers) {
      this.refundAll().then(() => {
        this.endGame();
        this.sendChannelMessage("Not enough players joined the game. Enter !start to start a new game");
      }).catch(() => {});
      return;
    }
    this.dealCards();
    this.goAroundTheTable();
  }

  private dealCards(): void {
    this.sendChannelMessage(`Round ${this.round++}. Dealing cards!`);
    this.deck = newShuffledDeck();

    for (let i = 0; i < 2; i++) {
      for (const hand of this.playerHands.values()) {
        hand.add(this.deck.shift()!);
      }
      this.dealerHand.add(this.deck.shift()!);
    }

    let cardsDealt = `DEALER ${this.dealerHand.at(0).toEmoticonHotkey()}`;
    for (const [player, hand] of this.playerHands) {
      cardsDealt += `, ${player} ${hand}`;
    }
    this.sendChannelMessage(cardsDealt);
    this.state       = BotState.PLAYING;
    this.playerOrder = [...this.playerHands.keys()];
    this.currentPlayerIdx = 0;
  }

  private goAroundTheTable(): void {
    this.clearDecisionTimer();

    while (this.currentPlayerIdx < this.playerOrder.length) {
      const player = this.playerOrder[this.currentPlayerIdx];
      const hand   = this.playerHands.get(player);
      if (!hand) { this.currentPlayerIdx++; continue; }

      const possibleCounts = hand.count();
      const count          = possibleCounts[0];

      if (count === 21) {
        this.sendChannelMessage(`${player} ${hand}, Blackjack!`);
        this.currentPlayerIdx++;
        continue;
      }

      const countStr = possibleCounts.length > 1
        ? `${possibleCounts[1]} or ${possibleCounts[0]}`
        : `${possibleCounts[0]}`;

      this.sendChannelMessage(`${player} ${hand}, ${countStr}, !h to hit or !s to stand`);

      const snapshot = player;
      this.decisionTimer = setTimeout(() => this.decisionTimeUp(snapshot), this.decisionMs);
      return;
    }

    const dealerCount = this.dealerHand.highestCount();
    this.sendChannelMessage(`DEALER on ${dealerCount} ${this.dealerHand}`);
    this.currentPlayerIdx = 0;

    if (dealerCount < 17) {
      this.dealerTimer = setTimeout(() => this.drawTo17(), this.dealerPauseMs);
    } else {
      this.dealerTimer = setTimeout(() => this.tallyUp(dealerCount), this.dealerPauseMs);
    }
  }

  private playerSays(username: string, decision: Decision): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage("Enter !start to start a game", username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage("Game starting soon! Please wait", username);
        break;
      case BotState.PLAYING: {
        const currentPlayer = this.playerOrder[this.currentPlayerIdx];
        if (username !== currentPlayer) {
          this.sendMessage("It's not your turn", username); return;
        }
        this.clearDecisionTimer();
        const hand = this.playerHands.get(username);
        if (!hand) { this.goAroundTheTable(); return; }

        if (decision === "HIT") {
          this.hit(username, hand);
        } else {
          this.stand(username, hand);
        }
        break;
      }
    }
  }

  private hit(username: string, hand: Hand): void {
    hand.add(this.deck.shift()!);
    const possibleCounts = hand.count();
    const count          = possibleCounts[0];

    if (count === 21) {
      this.sendChannelMessage(`${username} HIT and 21! ${hand}`);
      this.currentPlayerIdx++;
      this.goAroundTheTable();
    } else if (count > 21) {
      this.sendChannelMessage(`${username} HIT and BUST! ${hand}, ${count}`);
      this.playerHands.delete(username);
      this.currentPlayerIdx++;
      this.goAroundTheTable();
    } else {
      const countStr = possibleCounts.length > 1
        ? `${possibleCounts[1]} or ${possibleCounts[0]}`
        : `${possibleCounts[0]}`;
      this.sendChannelMessage(`${username} HIT ${hand}, ${countStr}, !h to hit or !s to stand`);

      const snapshot = username;
      this.decisionTimer = setTimeout(() => this.decisionTimeUp(snapshot), this.decisionMs);
    }
  }

  private stand(username: string, hand: Hand): void {
    this.sendChannelMessage(`${username} STAND on ${hand.highestCount()} ${hand}`);
    this.currentPlayerIdx++;
    this.goAroundTheTable();
  }

  private decisionTimeUp(username: string): void {
    this.currentPlayerIdx++;
    this.goAroundTheTable();
  }

  private drawTo17(): void {
    this.dealerTimer = null;
    this.dealerHand.add(this.deck.shift()!);
    const possibleCounts = this.dealerHand.count();
    const count          = possibleCounts[0];

    if (count < 17) {
      const countStr = possibleCounts.length > 1
        ? `${possibleCounts[1]} or ${possibleCounts[0]}`
        : `${possibleCounts[0]}`;
      this.sendChannelMessage(`DEALER HIT ${this.dealerHand}, ${countStr}`);
      this.dealerTimer = setTimeout(() => this.drawTo17(), this.dealerPauseMs);
    } else if (count <= 21) {
      this.sendChannelMessage(`DEALER HIT and STAND ${this.dealerHand}, ${count}`);
      this.dealerTimer = setTimeout(() => this.tallyUp(count), this.dealerPauseMs);
    } else {
      this.sendChannelMessage(`DEALER HIT and BUST ${this.dealerHand}, ${count}`);
      this.dealerTimer = setTimeout(() => this.tallyUp(count), this.dealerPauseMs);
    }
  }

  private tallyUp(dealerCount: number): void {
    this.dealerTimer = null;
    const losers: string[] = [];

    for (const [player, hand] of this.playerHands) {
      const playerCount = hand.highestCount();
      if ((dealerCount <= 21 && playerCount < dealerCount) || playerCount > 21) {
        losers.push(player);
      }
      hand.clear();
    }
    this.dealerHand.clear();

    if (losers.length !== this.playerHands.size) {
      for (const loser of losers) {
        this.playerHands.delete(loser);
      }
    }

    if (this.playerHands.size === 0) {
      this.endGame();
      this.sendChannelMessage("No more players left in the game. Enter !start to start a new game");
    } else if (this.playerHands.size === 1) {
      const winner = [...this.playerHands.keys()][0];
      const payout = this.totalPot;
      this.endGame();
      this.creditUser(winner, payout).catch(() => {});
      this.sendChannelMessage(
        `${winner} won IDR ${fmt(payout)}! ` +
        `Enter !start to start a game. IDR ${fmt(this.minCostToJoin)}. ` +
        `For custom entry, !start <entry_amount>`
      );
    } else {
      const remaining = [...this.playerHands.keys()].join(", ");
      this.sendChannelMessage(
        `${this.playerHands.size} players left in the game [${remaining}]`
      );
      this.dealCards();
      this.goAroundTheTable();
    }
  }

  private async refundAll(): Promise<void> {
    for (const player of this.playerHands.keys()) {
      await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private endGame(): void {
    this.clearTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.playerHands.clear();
    this.dealerHand.clear();
    this.playerOrder = [];
  }

  private clearDecisionTimer(): void {
    if (this.decisionTimer) { clearTimeout(this.decisionTimer); this.decisionTimer = null; }
  }

  private clearTimers(): void {
    this.clearDecisionTimer();
    if (this.waitTimer)   { clearTimeout(this.waitTimer);   this.waitTimer   = null; }
    if (this.dealerTimer) { clearTimeout(this.dealerTimer); this.dealerTimer = null; }
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "blackjack",
  displayName: "Blackjack",
  description: "Kartu 21 — capai 21 tanpa melewatinya.",
  category: "gambling",
  factory: ctx => new Blackjack(ctx),
});
