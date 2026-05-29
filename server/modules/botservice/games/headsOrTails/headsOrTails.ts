import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

type BetChoice = "HEAD" | "TAIL" | "UNKNOWN";

interface PlayerBet {
  choice: BetChoice;
  entryCost: number;
}

const COIN_HEAD = "(coin_head)";
const COIN_TAIL = "(coin_tail)";

function fmt(n: number): string {
  return n.toFixed(2);
}

function joinList(arr: string[]): string {
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}

export class HeadsOrTails extends BotBase {
  readonly gameType = "headsortails";

  private minPlayers: number;
  private waitForPlayerMs: number;
  private placeBetMs: number;
  private idleMs: number;
  private minPotEntry: number;
  private maxPotEntry: number;

  private costToJoin = 0;
  private playerBets = new Map<string, PlayerBet>();
  private round = 1;
  private numTiedRounds = 0;
  private maxTiedRounds = 5;
  private timeLastGameFinished = Date.now();

  private waitForPlayersTimer: NodeJS.Timeout | null = null;
  private tossCoinTimer: NodeJS.Timeout | null = null;

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers       = this.param("MinPlayers", 2);
    this.waitForPlayerMs  = this.param("WaitForPlayerInterval", 30_000);
    this.placeBetMs       = this.param("PlaceBetInterval", 10_000);
    this.idleMs           = this.param("IdleInterval", 1_800_000);
    this.minPotEntry      = this.param("minPotEntry", 0.03);
    this.maxPotEntry      = this.param("maxPotEntry", 500);

    this.sendChannelMessage(
      "Bot HeadsOrTails added to the room. !start to start a game of HeadsOrTails. " +
      "Cost: 0.00 credits. For custom entry: !start <amount>"
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
    if (this.waitForPlayersTimer) { clearTimeout(this.waitForPlayersTimer); this.waitForPlayersTimer = null; }
    if (this.tossCoinTimer)       { clearTimeout(this.tossCoinTimer);       this.tossCoinTimer = null; }
    this.endGame(true);
  }

  onUserJoinChannel(username: string): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          "Play Heads or Tails. !start to start a game. Cost: 0.00 credits. " +
          "For custom entry: !start <amount>", username
        );
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Play Heads or Tails. Enter !j to join the game. Cost: ${fmt(this.costToJoin)} credits`, username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("Heads or Tails is on now. Get ready for next game", username);
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
    if (msg.startsWith("!start"))    { this.startNewGame(username, msg).catch(e => console.error("[headsOrTails]", e)); return; }
    if (msg === "!j")                { this.joinGame(username).catch(e => console.error("[headsOrTails]", e));          return; }
    if (msg === "!h")                { this.placeBet(username, "HEAD");  return; }
    if (msg === "!t")                { this.placeBet(username, "TAIL");  return; }
    this.sendMessage(`${text} is not a valid command`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME: {
        const parts = msg.split(" ");
        let customEntry = 0;
        if (parts.length > 1) {
          const raw = parseInt(parts[1], 10);
          if (isNaN(raw)) {
            this.sendMessage("Invalid amount", username); return;
          }
          customEntry = raw / 100;
          if (customEntry !== 0 && customEntry < this.minPotEntry) {
            this.sendMessage(
              `Invalid amount. Minimum is ${fmt(this.minPotEntry)} credits`, username
            );
            return;
          }
          if (raw > this.maxPotEntry) {
            this.sendMessage(`Maximum bet is ${this.maxPotEntry} IDR`, username);
            return;
          }
        }
        if (customEntry > 0) {
          if (!(await this.userCanAfford(username, customEntry))) return;
          await this.chargeUser(username, customEntry);
        }
        this.costToJoin = customEntry;
        this.round = 1;
        this.numTiedRounds = 0;
        this.playerBets.clear();
        this.playerBets.set(username, { choice: "UNKNOWN", entryCost: customEntry });
        this.sendChannelMessage(`${username} started a new game`);
        this.waitForMorePlayers();
        break;
      }
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Enter !j to join the game. Cost: ${fmt(this.costToJoin)} credits`, username
        );
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
          "!start to start a game of HeadsOrTails. Cost: 0.00 credits. For custom entry: !start <amount>",
          username
        );
        break;
      case BotState.GAME_JOINING: {
        if (this.playerBets.has(username)) {
          this.sendMessage("You have already joined the game. Please wait for it to start", username);
          return;
        }
        if (this.costToJoin > 0) {
          if (!(await this.userCanAfford(username, this.costToJoin))) return;
          await this.chargeUser(username, this.costToJoin);
        }
        this.playerBets.set(username, { choice: "UNKNOWN", entryCost: this.costToJoin });
        this.sendChannelMessage(`${username} joined the game`);
        break;
      }
      case BotState.PLAYING:
        this.sendMessage("A game is currently in progress. Please wait for next game", username);
        break;
    }
  }

  private placeBet(username: string, bet: BetChoice): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          "!start to start a game of HeadsOrTails. Cost: 0.00 credits.", username
        );
        break;
      case BotState.GAME_JOINING:
        this.sendMessage("Game starting soon! Please wait", username);
        break;
      case BotState.PLAYING: {
        const existing = this.playerBets.get(username);
        if (!existing) {
          this.sendMessage("A game is currently in progress. Please wait for next game", username);
          return;
        }
        if (existing.choice === "UNKNOWN") {
          existing.choice = bet;
          this.sendMessage(`You have chosen ${bet === "HEAD" ? COIN_HEAD : COIN_TAIL}`, username);
        } else {
          this.sendMessage(
            `You have already chosen ${existing.choice === "HEAD" ? COIN_HEAD : COIN_TAIL}`, username
          );
        }
        break;
      }
    }
  }

  private waitForMorePlayers(): void {
    this.sendChannelMessage(
      `Waiting for more players. Enter !j to join. Cost: ${fmt(this.costToJoin)} credits`
    );
    this.state = BotState.GAME_JOINING;
    this.waitForPlayersTimer = setTimeout(() => this.chargeAndCountPlayers(), this.waitForPlayerMs);
  }

  private async chargeAndCountPlayers(): Promise<void> {
    this.waitForPlayersTimer = null;
    if (this.playerBets.size < this.minPlayers) {
      await this.refundAll();
      this.endGame(false);
      this.sendChannelMessage("Not enough players joined the game. Enter !start to start a new game");
      return;
    }
    this.waitForPlacingBets();
  }

  private waitForPlacingBets(): void {
    const sec = Math.round(this.placeBetMs / 1000);
    this.sendChannelMessage(
      `Round ${this.round++}. Tossing coin in ${sec} seconds. ` +
      `!h for ${COIN_HEAD} (Heads) or !t for ${COIN_TAIL} (Tails)`
    );
    this.state = BotState.PLAYING;
    this.tossCoinTimer = setTimeout(() => this.tossCoin(), this.placeBetMs);
  }

  private async tossCoin(): Promise<void> {
    this.tossCoinTimer = null;
    const heads: string[] = [];
    const tails: string[] = [];

    for (const [player, bet] of this.playerBets) {
      let choice = bet.choice;
      if (choice === "UNKNOWN") {
        choice = Math.random() < 0.5 ? "HEAD" : "TAIL";
        this.sendMessage(`You did not make a choice. Bot chose ${choice === "HEAD" ? COIN_HEAD : COIN_TAIL} for you`, player);
      }
      (choice === "HEAD" ? heads : tails).push(player);
      bet.choice = "UNKNOWN";
    }

    if (heads.length > 0)
      this.sendChannelMessage(`${joinList(heads)} picked ${COIN_HEAD}.`);
    if (tails.length > 0)
      this.sendChannelMessage(`${joinList(tails)} picked ${COIN_TAIL}.`);

    const coinLanded = Math.random() < 0.5 ? "HEAD" : "TAIL";
    this.sendChannelMessage(`Bot tossed ${coinLanded === "HEAD" ? COIN_HEAD : COIN_TAIL}`);
    const losers = coinLanded === "HEAD" ? tails : heads;

    const tiedRound = losers.length === 0 || losers.length === this.playerBets.size;

    if (!tiedRound) {
      for (const loser of losers) {
        this.playerBets.delete(loser);
      }
    }

    if (this.playerBets.size === 0) {
      this.endGame(false);
      this.sendChannelMessage("No more players left. Enter !start to start a new game");
    } else if (this.playerBets.size === 1) {
      const winner = [...this.playerBets.keys()][0];
      const payout = await this.distributeWinnings([winner]);
      this.sendChannelMessage(
        `${winner} won${payout > 0 ? " " + fmt(payout) + " credits" : ""}! ` +
        "!start to play again"
      );
      this.endGame(false);
    } else {
      if (tiedRound) {
        this.numTiedRounds++;
        if (this.numTiedRounds >= this.maxTiedRounds) {
          const remaining = [...this.playerBets.keys()];
          const payout = await this.distributeWinnings(remaining);
          this.sendChannelMessage(
            `Final tie-breaker round! It's a draw — remaining players split the prize` +
            (payout > 0 ? ` (${fmt(payout / remaining.length)} credits each)` : "") + "!"
          );
          this.endGame(false);
          return;
        }
      } else {
        this.numTiedRounds = 0;
      }
      const remaining = [...this.playerBets.keys()];
      this.sendChannelMessage(`${remaining.length} players left [${remaining.join(", ")}]`);
      this.waitForPlacingBets();
    }
  }

  private async distributeWinnings(winners: string[]): Promise<number> {
    if (this.costToJoin <= 0) return 0;
    const totalPot = this.costToJoin * this.playerBets.size;
    const perWinner = totalPot / winners.length;
    for (const w of winners) {
      await this.refundUser(w, perWinner);
    }
    return perWinner;
  }

  private async refundAll(): Promise<void> {
    for (const [player, bet] of this.playerBets) {
      if (bet.entryCost > 0) {
        await this.refundUser(player, bet.entryCost).catch(() => {});
      }
    }
  }

  private endGame(cancelPot: boolean): void {
    if (cancelPot) this.refundAll().catch(() => {});
    if (this.waitForPlayersTimer) { clearTimeout(this.waitForPlayersTimer); this.waitForPlayersTimer = null; }
    if (this.tossCoinTimer)       { clearTimeout(this.tossCoinTimer);       this.tossCoinTimer = null; }
    this.timeLastGameFinished = Date.now();
    this.state       = BotState.NO_GAME;
    this.costToJoin  = 0;
    this.numTiedRounds = 0;
    this.playerBets.clear();
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "headsortails",
  displayName: "Heads or Tails",
  description: "Lempar koin — Heads atau Tails?",
  category: "gambling",
  factory: ctx => new HeadsOrTails(ctx),
});
