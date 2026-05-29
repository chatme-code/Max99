import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";
import {
  Card,
  BLUE, GREEN, RED, YELLOW, WILD_COLOR,
  WILD, DRAW_2, REVERSE, SKIP, WILD_DRAW_4, ANY,
  STR_WILD, STR_DRAW_2, STR_REVERSE, STR_SKIP, STR_WILD_DRAW_4,
  COLOR_CHARS, COLOR_EMOTICONS,
} from "./oneCard";
import { Player } from "./onePlayer";
import { storage } from "../../../../storage";
import { LEADERBOARD_TYPE, LEADERBOARD_PERIOD } from "@shared/schema";

const HOUSE_TAX_RATE = 0.10;

function fmtIDR(n: number): string {
  return `${Number.isInteger(n) ? Math.round(n).toString() : n.toFixed(2)} IDR`;
}

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

export class One extends BotBase {
  readonly gameType = "uno";

  private minCostToJoin:  number;
  private maxCostToJoin:  number;
  private timeToJoinGame: number;
  private idleMs:         number;

  private costToJoin = 0;
  private totalPot   = 0;
  private drawn       = false;
  private inProgress  = false;
  private dealer      = "";
  private wildColour  = WILD_COLOR;

  private playersList: Player[] = [];
  private playerNames: Record<string, boolean> = {};
  private cardDeck:    Card[]   = [];
  private discardPile: Card[]   = [];
  private cardInPlay:  Card | null = null;
  private nextPlayer:  Player | null = null;

  private waitTimer: NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minCostToJoin  = this.param("MinCostToJoinGame",     500);
    this.maxCostToJoin  = this.param("MaxCostToJoinGame", 999_999_999);
    this.timeToJoinGame = this.param("TimeToJoinGame", 90_000);
    this.idleMs         = this.param("IdleInterval", 1_800_000);

    this.sendChannelMessage(`Play One - the card game. !start to start. Cost ${fmtIDR(this.costToJoin)}`);
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME && Date.now() - this.timeLastGameFinished > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state !== BotState.PLAYING && this.state !== BotState.GAME_JOINING;
  }

  stopBot(): void {
    this.clearAllTimers();
    this.refundAll().catch(() => {});
    this.resetGame();
  }

  onUserJoinChannel(username: string): void {
    if (this.inProgress || this.state === BotState.PLAYING) {
      this.sendMessage(`'One' game in progress... `, username);
    } else {
      this.sendMessage(
        `Play One - the card game. !start to start. Cost ${fmtIDR(this.costToJoin)}`,
        username
      );
    }
  }

  onUserLeaveChannel(username: string): void {
    this.removePlayer(username);
  }

  onMessage(username: string, text: string, _ts: number): void {
    const lower = text.toLowerCase().trim();
    if (lower.startsWith("!start")) { this.startGame(username, lower).catch(e => console.error("[one]", e)); return; }
    if (lower === "!j") { this.addPlayerCmd(username).catch(e => console.error("[one]", e)); return; }
    if (lower === "!deal") { this.dealGame(username); return; }
    if (lower === "!h") { this.sendHand(username); return; }
    if (lower === "!c") { this.count(); return; }
    if (lower.startsWith("!d") && this.inProgress && this.isPlayersTurn(username)) {
      this.draw(username); return;
    }
    if (lower.startsWith("!s") && this.inProgress && this.isPlayersTurn(username)) {
      this.pass(username); return;
    }
    if (lower.startsWith("!p") && this.inProgress) {
      if (this.isPlayersTurn(username)) {
        this.playCardCmd(username, lower); return;
      } else {
        this.sendMessage(`[PVT] ${username}: It is not your turn.`, username); return;
      }
    }
    if (lower === "!reset" && username === this.gameStarter) {
      this.reset(username); return;
    }
  }

  private async startGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendGameCannotBeStartedMessage(username);
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let cost = 0;
    if (parts.length > 1) {
      const parsed = parseFloat(parts[1]);
      if (isNaN(parsed)) {
        this.sendMessage(`[PVT] ${username}: Invalid amount`, username);
        return;
      }
      if (parsed < this.minCostToJoin && parsed !== 0) {
        this.sendMessage(
          `[PVT] ${username}: Invalid amount. Minimum amount is ${fmtIDR(this.minCostToJoin)}`,
          username
        );
        return;
      }
      if (parsed > this.maxCostToJoin) {
        this.sendMessage(`[PVT] ${username}: Invalid amount`, username);
        return;
      }
      cost = parsed > 0 ? parsed : 0;
    }
    if (cost > 0 && !(await this.userCanAfford(username, cost))) return;
    if (cost > 0) await this.chargeUser(username, cost);
    this.costToJoin = cost;
    this.totalPot = cost;
    this.gameStarter = username;
    this.state = BotState.GAME_JOINING;
    this.addPlayerInternal(username);

    const secs = Math.round(this.timeToJoinGame / 1000);
    if (cost > 0) {
      this.sendChannelMessage(
        `${username} started a game of One. !j to join. Cost ${fmtIDR(cost)}. ${secs} seconds`
      );
    } else {
      this.sendChannelMessage(
        `${username} started a game of One. !j to join. ${secs} seconds`
      );
    }

    this.waitTimer = setTimeout(() => this.beginPlay(), this.timeToJoinGame);
  }

  private sendGameCannotBeStartedMessage(username: string): void {
    let message: string;
    if (this.state === BotState.PLAYING) {
      message = "A game is currently on.";
    } else if (this.state === BotState.GAME_JOINING) {
      message = "A game is on. !j to join. Charges may apply.";
    } else {
      message = "Sorry, new game cannot be started now.";
    }
    this.sendMessage(`[PVT] ${message}`, username);
  }

  private async addPlayerCmd(username: string): Promise<void> {
    if (this.playersList.length >= 4) {
      this.sendMessage(
        `[PVT] ${username}: Sorry, only 4 players in a game.  Please wait for the next game.`,
        username
      );
      return;
    }
    if (this.playerNames[username] !== undefined) {
      this.sendMessage(`[PVT] ${username}: You are already added to game.`, username);
      return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage(`[PVT] ${username}: Sorry, a game has already started.`, username);
      return;
    }
    if (this.costToJoin > 0 && username !== this.gameStarter) {
      if (!(await this.userCanAfford(username, this.costToJoin))) return;
      await this.chargeUser(username, this.costToJoin);
      this.totalPot += this.costToJoin;
    }
    this.addPlayerInternal(username);
    this.sendMessage(`[PVT] ${username}: added to game. `, username);
    if (username !== this.gameStarter) {
      this.sendChannelMessage(`${username} joined the game.`);
    }
  }

  private addPlayerInternal(username: string): void {
    const player = new Player(username);
    this.playersList.push(player);
    if (!this.dealer) {
      this.dealer = username;
      this.playerNames[username] = true;
    } else {
      this.playerNames[username] = false;
    }
  }

  private dealGame(username: string): void {
    if (username.toLowerCase() !== this.dealer.toLowerCase()) return;
    if (this.inProgress) return;
    if (this.playersList.length < 2) {
      this.sendChannelMessage(`${username}: You need at least 1 more player to start a game.`);
      return;
    }
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
    this.inProgress = true;
    this.state = BotState.PLAYING;
    this.setNextPlayer(this.playersList[1]);
    this.deal();
    this.cardInPlay = this.drawFromDeck();
    if (this.cardInPlay) this.discardPile.push(this.cardInPlay);

    while (this.cardInPlay && (this.cardInPlay.getValue() === WILD || this.cardInPlay.getValue() === WILD_DRAW_4)) {
      this.cardInPlay = this.drawFromDeck();
      if (this.cardInPlay) this.discardPile.push(this.cardInPlay);
    }

    if (this.cardInPlay) {
      const v = this.cardInPlay.getValue();
      if (v === REVERSE) {
        if (this.playersList.length > 2) this.advanceNextPlayer(-1);
        this.reversePlayerOrder();
      } else if (v === SKIP) {
        this.sendMessage(`[PVT] ${this.nextPlayer!.getName()} has been skipped.`, this.nextPlayer!.getName());
        this.advanceNextPlayer(1);
      } else if (v === DRAW_2) {
        if (this.drawCards(this.nextPlayer!.getName(), 1)) {
          this.drawCards(this.nextPlayer!.getName(), 1);
        } else {
          this.noCardsLeft();
          this.drawCards(this.nextPlayer!.getName(), 2);
        }
        this.sendChannelMessage(`${this.nextPlayer!.getName()} takes 2 extra cards and is skipped.`);
        this.advanceNextPlayer(1);
      }
    }
    this.showTopCard();
  }

  private beginPlay(): void {
    this.waitTimer = null;
    if (this.playersList.length < 2) {
      this.sendChannelMessage(`Joining ends. Not enough players. Need 2.`);
      this.refundAll().then(() => this.resetGame());
      return;
    }
    this.sendChannelMessage(
      `"BotOne" just started. ${this.gameStarter}, !deal to deal cards.`
    );
  }

  private deal(): void {
    this.initDeck();
    for (const player of this.playersList) {
      for (let x = 0; x < 7; x++) {
        const idx = randomInt(this.cardDeck.length);
        player.addCard(this.cardDeck[idx]);
        this.cardDeck.splice(idx, 1);
      }
      this.sendMessage(`[PVT] ${player.toString()}`, player.getName());
    }
  }

  private initDeck(): void {
    this.cardDeck = [];
    const colors = [BLUE, GREEN, RED, YELLOW];
    for (const col of colors) this.cardDeck.push(new Card(col, 0));
    for (let y = 0; y <= 1; y++) {
      for (let v = 1; v <= 9; v++) {
        for (const col of colors) this.cardDeck.push(new Card(col, v));
      }
    }
    for (let x = 0; x < 2; x++) {
      for (const col of colors) {
        this.cardDeck.push(new Card(col, DRAW_2));
        this.cardDeck.push(new Card(col, REVERSE));
        this.cardDeck.push(new Card(col, SKIP));
      }
    }
    for (let x = 0; x < 4; x++) {
      this.cardDeck.push(new Card(WILD_COLOR, WILD));
      this.cardDeck.push(new Card(WILD_COLOR, WILD_DRAW_4));
    }
    this.wildColour = WILD_COLOR;
    this.discardPile = [];
  }

  private redeal(): void {
    this.wildColour = WILD_COLOR;
    const colors = [BLUE, GREEN, RED, YELLOW];
    for (const col of colors) this.cardDeck.push(new Card(col, 0));
    for (let y = 0; y <= 1; y++) {
      for (let v = 1; v <= 9; v++) {
        for (const col of colors) this.cardDeck.push(new Card(col, v));
      }
    }
    for (let x = 0; x < 2; x++) {
      for (const col of colors) {
        this.cardDeck.push(new Card(col, DRAW_2));
        this.cardDeck.push(new Card(col, REVERSE));
        this.cardDeck.push(new Card(col, SKIP));
      }
    }
    for (let x = 0; x < 4; x++) {
      this.cardDeck.push(new Card(WILD_COLOR, WILD));
      this.cardDeck.push(new Card(WILD_COLOR, WILD_DRAW_4));
    }
    for (const p of this.playersList) {
      for (const c of p.getCards()) {
        const idx = this.cardDeck.findIndex(dc => dc.equals(c));
        if (idx !== -1) this.cardDeck.splice(idx, 1);
      }
    }
  }

  private drawFromDeck(): Card | null {
    if (this.cardDeck.length === 0) return null;
    const idx = randomInt(this.cardDeck.length);
    const card = this.cardDeck[idx];
    this.cardDeck.splice(idx, 1);
    return card;
  }

  private noCardsLeft(): void {
    this.sendChannelMessage("There are no cards left in the pack.  Shuffling..");
    this.redeal();
  }

  private drawCards(playerName: string, numCards: number): boolean {
    const player = this.getPlayer(playerName);
    if (!player || !this.cardDeck) return false;
    if (this.cardDeck.length === 0) {
      if (this.discardPile.length >= numCards) {
        this.cardDeck = [...this.discardPile];
        this.discardPile = [];
      } else {
        return false;
      }
    }
    let drawnStr = "You Drew: ";
    for (let x = 0; x < numCards; x++) {
      if (this.cardDeck.length === 0) return false;
      const card = this.drawFromDeck()!;
      player.addCard(card);
      drawnStr += card.toString() + " ";
    }
    this.sendMessage(`[PVT] ${drawnStr.trim()}`, playerName);
    return true;
  }

  private draw(sender: string): void {
    if (this.drawCards(sender, 1)) {
      this.sendChannelMessage(`${sender} took a card from the deck.`);
    } else {
      this.noCardsLeft();
      this.drawCards(sender, 1);
      this.sendChannelMessage(`${sender} took a card from the deck.`);
    }
    this.drawn = true;
  }

  private pass(sender: string): void {
    if (this.drawn) {
      this.sendChannelMessage(`Counts of Cards: `);
      this.advanceNextPlayer(1);
      this.showTopCard();
      this.drawn = false;
    } else {
      this.sendMessage(`[PVT] ${sender}: You have to draw first then pass`, sender);
    }
  }

  private sendHand(playerName: string): void {
    const player = this.getPlayer(playerName);
    if (player) this.sendMessage(player.toString(), playerName);
  }

  private count(): void {
    let res = "Counts of Cards: ";
    for (const p of this.playersList) {
      res += `${p.getName()}: (${p.cardCount()}) `;
    }
    this.sendChannelMessage(res.trim());
  }

  private reset(sender: string): void {
    if (sender.toLowerCase() === this.dealer.toLowerCase()) {
      this.endGame(true, null);
      this.sendChannelMessage(`${sender} has reset the game. !start to start new One game`);
    }
  }

  private playCardCmd(sender: string, message: string): void {
    const valid = this.playCard(sender, message);
    if (!valid) return;

    const player = this.getPlayer(sender);
    if (!player) return;

    if (player.hasWon()) {
      let totalScore = 0;
      for (const p of this.playersList) {
        if (p.getName().toLowerCase() === sender.toLowerCase()) continue;
        totalScore += p.getPoints();
        this.sendChannelMessage(p.toString());
      }
      this.sendChannelMessage(
        ` ${sender} won ${totalScore} points! !start to start new One game`
      );
      this.recordGameLeaderboard(sender).catch(() => {});
      this.endGame(false, sender);
      return;
    }

    if (player.hasUno()) {
      this.sendChannelMessage(`${sender} has *** ONE ***!" w00t!`);
    }
    this.showTopCard();
    this.drawn = false;
  }

  private playCard(sender: string, message: string): boolean {
    const player = this.getPlayer(sender);
    if (!player) return false;

    const cardToPlay = message.toLowerCase().substring("!p".length).trim();
    let cardValue  = -1;
    let cardColour = -1;
    let cardColourStr = "";

    try {
      if (cardToPlay.indexOf(STR_WILD_DRAW_4) !== -1 && cardToPlay.length === 5) {
        cardValue = WILD_DRAW_4;
        cardColourStr = cardToPlay.charAt(4);
      } else if (cardToPlay.indexOf(STR_DRAW_2) !== -1 && cardToPlay.length === 4) {
        cardValue = DRAW_2;
        cardColourStr = cardToPlay.charAt(0);
      } else if (cardToPlay.charAt(2) === "r" && cardToPlay.indexOf(STR_WILD) === -1 && cardToPlay.length === 3) {
        cardValue = REVERSE;
        cardColourStr = cardToPlay.charAt(0);
      } else if (cardToPlay.indexOf(STR_SKIP) !== -1 && cardToPlay.length === 3) {
        cardValue = SKIP;
        cardColourStr = cardToPlay.charAt(0);
      } else if (cardToPlay.indexOf(STR_WILD) !== -1 && cardToPlay.length === 3) {
        cardValue = WILD;
        cardColourStr = cardToPlay.charAt(2);
      } else {
        cardValue = parseInt(cardToPlay.charAt(1), 10);
        cardColourStr = cardToPlay.charAt(0);
      }

      if (!["b", "g", "r", "y"].includes(cardColourStr)) {
        this.sendMessage(`[PVT] ${sender}: Invalid Color Selection`, sender);
        return false;
      }
      cardColour = COLOR_CHARS[cardColourStr];

    } catch {
      this.sendMessage(`[PVT] ${sender}: You cannot play that card or you don't have it.`, sender);
      return false;
    }

    if (cardColour === this.cardInPlay?.getColour() ||
        cardColour === this.wildColour ||
        cardValue  === this.cardInPlay?.getValue() ||
        cardValue  === WILD ||
        cardValue  === WILD_DRAW_4) {

      const card = player.getCard(cardValue, cardColour);
      if (!card) {
        this.sendMessage(`[PVT] ${sender}: You cannot play that card or you don't have it.`, sender);
        return false;
      }

      this.discardPile.push(card);
      this.cardInPlay = card;
      player.removeCard(card);
      let additionalInfo = ".";

      if (cardValue === WILD_DRAW_4) {
        this.wildColour = cardColour;
        this.advanceNextPlayer(1);
        if (this.drawCards(this.nextPlayer!.getName(), 4)) {
          const newCard = new Card(cardColour, ANY);
          additionalInfo = ` and changes colour to ${newCard} ${this.nextPlayer!.getName()} takes 4 extra cards and is skipped.`;
          this.advanceNextPlayer(1);
        } else {
          this.noCardsLeft();
          return true;
        }

      } else if (cardValue === DRAW_2) {
        this.advanceNextPlayer(1);
        if (this.drawCards(this.nextPlayer!.getName(), 2)) {
          additionalInfo = ` ${this.nextPlayer!.getName()} takes 2 extra cards and is skipped.`;
          this.advanceNextPlayer(1);
        } else {
          this.noCardsLeft();
          return true;
        }

      } else if (cardValue === REVERSE) {
        if (this.playersList.length > 2) this.advanceNextPlayer(-1);
        additionalInfo = `, turn goes back to ${this.nextPlayer!.getName()}`;
        this.reversePlayerOrder();

      } else if (cardValue === SKIP) {
        this.advanceNextPlayer(1);
        additionalInfo = `, ${this.nextPlayer!.getName()} skipped.`;
        this.advanceNextPlayer(1);

      } else if (cardValue === WILD) {
        this.wildColour = cardColour;
        const newCard = new Card(cardColour, ANY);
        additionalInfo = ` and changes colour to ${newCard}`;
        this.advanceNextPlayer(1);

      } else {
        this.advanceNextPlayer(1);
      }

      this.sendChannelMessage(`${sender} plays ${this.cardInPlay}${additionalInfo}`);

      if (cardValue !== WILD && cardValue !== WILD_DRAW_4) {
        this.wildColour = WILD_COLOR;
      }

      return true;
    }

    if (player.hasCardWithValue(cardValue) || player.hasCardWithColour(cardColour)) {
      this.sendMessage(
        `[PVT] ${sender}: You have to play a card following on from the last played card, or a wild.`,
        sender
      );
    } else {
      this.sendMessage(`[PVT] ${sender}: You cannot play that card or you don't have it.`, sender);
    }
    return false;
  }

  private reversePlayerOrder(): void {
    this.playersList = [...this.playersList].reverse();
  }

  private advanceNextPlayer(increment: number): void {
    if (!this.nextPlayer || this.playersList.length === 0) return;
    let idx = this.playersList.indexOf(this.nextPlayer);
    idx += increment;
    if (idx > this.playersList.length - 1) {
      this.nextPlayer = this.playersList[0];
    } else if (idx < 0) {
      this.nextPlayer = this.playersList[this.playersList.length - 1];
    } else {
      this.nextPlayer = this.playersList[idx];
    }
  }

  private setNextPlayer(player: Player): void {
    this.nextPlayer = player;
  }

  private getPlayer(name: string): Player | null {
    return this.playersList.find(p => p.getName().toLowerCase() === name.toLowerCase()) ?? null;
  }

  private isPlayersTurn(sender: string): boolean {
    return this.nextPlayer !== null &&
           this.nextPlayer.getName().toLowerCase() === sender.toLowerCase();
  }

  private showTopCard(): void {
    if (!this.cardInPlay || !this.nextPlayer) return;
    let additionalInfo = "";
    if ([BLUE, GREEN, RED, YELLOW].includes(this.wildColour)) {
      additionalInfo = ` and colour is ${COLOR_EMOTICONS[this.wildColour]}*`;
    }
    this.sendChannelMessage(
      `${this.nextPlayer.getName()}: it's your turn <!p to play, !s to pass, !d to draw a card>. Top card is ${this.cardInPlay}${additionalInfo}`
    );
    this.sendMessage(
      `[PVT] Your cards: ${this.getPlayer(this.nextPlayer.getName())?.getHand().map(c => c.toString()).join(" ") ?? ""}`,
      this.nextPlayer.getName()
    );
  }

  private removePlayer(name: string): void {
    const player = this.getPlayer(name);
    if (!player) return;

    delete this.playerNames[name];

    if (this.nextPlayer && this.nextPlayer.getName().toLowerCase() === name.toLowerCase()) {
      this.advanceNextPlayer(1);
    }

    if (this.costToJoin > 0 && !this.inProgress) {
      this.refundUser(name, this.costToJoin).catch(() => {});
      this.totalPot = Math.max(0, this.totalPot - this.costToJoin);
    }

    this.discardPile.push(...player.getCards());
    this.playersList = this.playersList.filter(p => p !== player);

    if (this.nextPlayer) {
      this.sendChannelMessage(
        `${name} has been removed from the game. ${this.nextPlayer.getName()} it's your turn now.`
      );
    }

    if (this.playersList.length === 1 && this.inProgress) {
      const winner = this.playersList[0].getName();
      this.sendChannelMessage(`No other players left so ${winner} wins! \\o/  !start to start new One game`);
      this.recordGameLeaderboard(winner).catch(() => {});
      this.endGame(false, winner);
    } else if (this.playersList.length === 0) {
      this.sendChannelMessage(`All players left the room - no winner. !start to start new One game`);
      this.endGame(true, null);
    }
  }

  private endGame(cancelPot: boolean, winner: string | null): void {
    if (!cancelPot && winner && this.costToJoin > 0) {
      const { payout, tax } = this.calculatePayout();
      if (payout > 0) {
        this.creditUser(winner, payout).catch(() => {});
        this.sendChannelMessage(`${winner} won ${fmtIDR(payout)} after ${fmtIDR(tax)} tax.`);
      }
    }
    this.resetGame();
    this.sendChannelMessage(`Play One - the card game. !start to start. Cost ${fmtIDR(this.costToJoin)}`);
  }

  private calculatePayout(): { payout: number; tax: number } {
    const tax = Math.round(this.totalPot * HOUSE_TAX_RATE * 100) / 100;
    const payout = Math.round((this.totalPot - tax) * 100) / 100;
    return { payout, tax };
  }

  private async recordGameLeaderboard(winner: string | null): Promise<void> {
    const allPlayers = this.playersList.map(p => p.getName());
    const periods = [LEADERBOARD_PERIOD.DAILY, LEADERBOARD_PERIOD.ALL_TIME];
    try {
      await Promise.all(
        allPlayers.flatMap(username =>
          periods.map(period =>
            storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.ONE_GAMES_PLAYED, period, username, 1, true)
          )
        )
      );
      if (winner) {
        await Promise.all(
          periods.map(period =>
            storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.ONE_MOST_WINS, period, winner, 1, true)
          )
        );
        await Promise.all(
          periods.map(period =>
            storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.TOTAL_MOST_WINS, period, winner, 1, true)
          )
        );
      }
    } catch {
    }
  }

  private async refundAll(): Promise<void> {
    if (this.costToJoin <= 0) return;
    for (const name of Object.keys(this.playerNames)) {
      await this.refundUser(name, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state      = BotState.NO_GAME;
    this.inProgress = false;
    this.drawn      = false;
    this.dealer     = "";
    this.costToJoin = 0;
    this.totalPot   = 0;
    this.wildColour = WILD_COLOR;
    this.playersList = [];
    this.playerNames = {};
    this.cardDeck    = [];
    this.discardPile = [];
    this.cardInPlay  = null;
    this.nextPlayer  = null;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "uno",
  displayName: "UNO",
  description: "Game kartu UNO klasik — habiskan kartu lebih dulu!",
  category: "table",
  factory: ctx => new One(ctx),
});
