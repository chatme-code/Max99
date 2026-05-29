import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

type Hand = "ROCK" | "PAPER" | "SCISSORS" | "CLOSED";

const EMOJI: Record<Hand, string> = {
  ROCK:     "(rock)",
  PAPER:    "(paper)",
  SCISSORS: "(scissors)",
  CLOSED:   "(?)",
};

function joinList(arr: string[]): string {
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}

function fmt(n: number): string { return n.toFixed(2); }

function randomHand(): Hand {
  const hands: Hand[] = ["ROCK", "PAPER", "SCISSORS"];
  return hands[Math.floor(Math.random() * 3)];
}

interface PlayerHand {
  hand: Hand;
  entryCost: number;
}

export class RockPaperScissors extends BotBase {
  readonly gameType = "rockpaperscissors";

  private minPlayers:       number;
  private maxPlayers:       number;
  private waitForPlayerMs:  number;
  private countDownMs:      number;
  private idleMs:           number;
  private minCostToJoin:    number;
  private maxCostToJoin:    number;

  private costToJoin = 0;
  private playerHands = new Map<string, PlayerHand>();
  private round = 1;
  private timeLastGameFinished = Date.now();
  private waitTimer: NodeJS.Timeout | null = null;
  private countDownTimer: NodeJS.Timeout | null = null;

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.maxPlayers      = this.param("MaxPlayers", 5);
    this.waitForPlayerMs = this.param("WaitForPlayerInterval", 30_000);
    this.countDownMs     = this.param("CountDownInterval", 10_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 500);

    this.sendChannelMessage(
      `Bot RockPaperScissors added. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      "For custom entry: !start <amount>"
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
    if (this.waitTimer)      { clearTimeout(this.waitTimer);      this.waitTimer = null; }
    if (this.countDownTimer) { clearTimeout(this.countDownTimer); this.countDownTimer = null; }
    this.refundAll().catch(() => {});
    this.endGame(false);
  }

  onUserJoinChannel(username: string): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          `Play Rock, Paper, Scissors. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username
        );
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `RPS game forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`, username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("RPS is on now. Get ready for next game", username);
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
    if (msg.startsWith("!start")) { this.startNewGame(username, msg).catch(e => console.error("[rps]", e)); return; }
    if (msg === "!j")             { this.joinGame(username).catch(e => console.error("[rps]", e));          return; }
    if (msg === "!r")             { this.pickHand(username, "ROCK");     return; }
    if (msg === "!p")             { this.pickHand(username, "PAPER");    return; }
    if (msg === "!s")             { this.pickHand(username, "SCISSORS"); return; }
    this.sendMessage(`${text} is not a valid command`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME: {
        const parts = msg.trim().split(/\s+/);
        let cost = this.minCostToJoin;
        if (parts.length > 1) {
          const rawInput = parseFloat(parts[1]);
          const parsed = rawInput / 100;
          if (isNaN(parsed)) {
            this.sendMessage(`${parts[1]} is not a valid amount`, username); return;
          }
          if (parsed < this.minCostToJoin) {
            this.sendMessage(
              `Minimum amount is ${fmt(this.minCostToJoin)} credits`, username
            );
            return;
          }
          if (rawInput > this.maxCostToJoin) {
            this.sendMessage(`Maximum bet is ${this.maxCostToJoin} IDR`, username); return;
          }
          cost = parsed;
        }
        if (!(await this.userCanAfford(username, cost))) return;
        await this.chargeUser(username, cost);
        this.costToJoin = cost;
        this.round = 1;
        this.playerHands.clear();
        this.playerHands.set(username, { hand: "CLOSED", entryCost: cost });
        this.sendChannelMessage(`${username} started a Rock, Paper, Scissors game!`);
        this.waitForMorePlayers();
        break;
      }
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Enter !j to join the game. Entry: ${fmt(this.costToJoin)} credits`, username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("A game is currently in progress. Please wait", username);
        break;
    }
  }

  private async joinGame(username: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          `!start to start a game. Min entry: ${fmt(this.minCostToJoin)} credits`, username
        );
        break;
      case BotState.GAME_JOINING: {
        if (this.playerHands.has(username)) {
          this.sendMessage("You have already joined. Please wait for the game to start", username);
          return;
        }
        if (this.playerHands.size >= this.maxPlayers) {
          this.sendMessage("Game is full. Please wait for the next game", username);
          return;
        }
        if (!(await this.userCanAfford(username, this.costToJoin))) return;
        await this.chargeUser(username, this.costToJoin);
        this.playerHands.set(username, { hand: "CLOSED", entryCost: this.costToJoin });
        this.sendChannelMessage(`${username} joined the game`);
        break;
      }
      case BotState.PLAYING:
        this.sendMessage("A game is currently in progress. Please wait", username);
        break;
    }
  }

  private pickHand(username: string, hand: Hand): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage("!start to start a game", username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage("Game starting soon! Please wait", username);
        break;
      case BotState.PLAYING: {
        const existing = this.playerHands.get(username);
        if (!existing) {
          this.sendMessage("A game is in progress. Please wait for next game", username);
          return;
        }
        if (existing.hand === "CLOSED") {
          existing.hand = hand;
          this.sendMessage(`You picked ${EMOJI[hand]}`, username);
        } else {
          this.sendMessage(`You already picked ${EMOJI[existing.hand]}`, username);
        }
        break;
      }
    }
  }

  private waitForMorePlayers(): void {
    this.sendChannelMessage(
      `Waiting for more players. !j to join. Entry: ${fmt(this.costToJoin)} credits. ` +
      `${Math.round(this.waitForPlayerMs / 1000)}s to join.`
    );
    this.state = BotState.GAME_JOINING;
    this.waitTimer = setTimeout(() => this.chargeAndCountPlayers(), this.waitForPlayerMs);
  }

  private async chargeAndCountPlayers(): Promise<void> {
    this.waitTimer = null;
    if (this.playerHands.size < this.minPlayers) {
      await this.refundAll();
      this.endGame(false);
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.countDown();
  }

  private countDown(): void {
    const sec = Math.round(this.countDownMs / 1000);
    this.sendChannelMessage(
      `Round ${this.round++}. Counting down... Pick: ` +
      `!r ${EMOJI.ROCK}  !p ${EMOJI.PAPER}  !s ${EMOJI.SCISSORS}. ${sec}s`
    );
    this.state = BotState.PLAYING;
    this.countDownTimer = setTimeout(() => this.pickWinner(), this.countDownMs);
  }

  private async pickWinner(): Promise<void> {
    this.countDownTimer = null;
    const rocks: string[]    = [];
    const papers: string[]   = [];
    const scissors: string[] = [];

    for (const [player, ph] of this.playerHands) {
      let hand = ph.hand;
      if (hand === "CLOSED") {
        hand = randomHand();
        this.sendMessage(`You didn't pick! Bot picked ${EMOJI[hand]} for you`, player);
        ph.hand = hand;
      }
      if (hand === "ROCK")     rocks.push(player);
      if (hand === "PAPER")    papers.push(player);
      if (hand === "SCISSORS") scissors.push(player);
      ph.hand = "CLOSED";
    }

    if (rocks.length > 0)    this.sendChannelMessage(`${joinList(rocks)} picked ${EMOJI.ROCK}.`);
    if (papers.length > 0)   this.sendChannelMessage(`${joinList(papers)} picked ${EMOJI.PAPER}.`);
    if (scissors.length > 0) this.sendChannelMessage(`${joinList(scissors)} picked ${EMOJI.SCISSORS}.`);

    let losers: string[] = [];

    if (rocks.length > 0 && scissors.length > 0 && papers.length === 0) {
      this.sendChannelMessage(`${EMOJI.ROCK} wins!`);
      losers = scissors;
    } else if (scissors.length > 0 && papers.length > 0 && rocks.length === 0) {
      this.sendChannelMessage(`${EMOJI.SCISSORS} wins!`);
      losers = papers;
    } else if (papers.length > 0 && rocks.length > 0 && scissors.length === 0) {
      this.sendChannelMessage(`${EMOJI.PAPER} wins!`);
      losers = rocks;
    } else {
      this.sendChannelMessage("Draw!");
      losers = [];
    }

    for (const loser of losers) {
      this.playerHands.delete(loser);
    }

    if (this.playerHands.size === 0) {
      this.endGame(false);
      this.sendChannelMessage("No players remain. Enter !start to play again");
    } else if (this.playerHands.size === 1) {
      const winner = [...this.playerHands.keys()][0];
      const payout = await this.distributeWinnings([winner]);
      this.sendChannelMessage(
        `${winner} wins${payout > 0 ? " " + fmt(payout) + " credits" : ""}! ` +
        "Enter !start to play again"
      );
      this.endGame(false);
    } else {
      const remaining = [...this.playerHands.keys()];
      this.sendChannelMessage(`${remaining.length} players remain [${remaining.join(", ")}]`);
      this.countDown();
    }
  }

  private async distributeWinnings(winners: string[]): Promise<number> {
    if (this.costToJoin <= 0) return 0;
    const allEntries = [...this.playerHands.values()].reduce((s, p) => s + p.entryCost, 0);
    const perWinner = allEntries / winners.length;
    for (const w of winners) {
      await this.refundUser(w, perWinner).catch(() => {});
    }
    return perWinner;
  }

  private async refundAll(): Promise<void> {
    for (const [player, ph] of this.playerHands) {
      if (ph.entryCost > 0) {
        await this.refundUser(player, ph.entryCost).catch(() => {});
      }
    }
  }

  private endGame(doRefund: boolean): void {
    if (doRefund) this.refundAll().catch(() => {});
    if (this.waitTimer)      { clearTimeout(this.waitTimer);      this.waitTimer = null; }
    if (this.countDownTimer) { clearTimeout(this.countDownTimer); this.countDownTimer = null; }
    this.timeLastGameFinished = Date.now();
    this.state       = BotState.NO_GAME;
    this.costToJoin  = 0;
    this.playerHands.clear();
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "rockpaperscissors",
  displayName: "Rock Paper Scissors",
  description: "Gunting Batu Kertas klasik — kalahkan bot!",
  category: "social",
  factory: ctx => new RockPaperScissors(ctx),
});
