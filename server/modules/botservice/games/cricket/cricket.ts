import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";
import { Deck, CricketCard, getCardType, getCardName } from "./deck";

function fmt(n: number): string { return Math.round(n).toString(); }

// Sorts map entries descending by value (mirrors Cricket.kt sortByValue)
function sortByValueDesc(map: Map<string, number>): Map<string, number> {
  return new Map([...map.entries()].sort((a, b) => b[1] - a[1]));
}

export class Cricket extends BotBase {
  readonly gameType = "cricket";

  // Parameters (mirrors Kotlin field names)
  private minAmountJoinPot: number;
  private amountJoinPot:    number;
  private timeToJoinGame:   number;   // seconds
  private timeToCancel:     number;   // seconds — GAME_STARTING grace period
  private timeToEndRound:   number;   // seconds
  private waitBetweenRound: number;   // ms
  private idleMs:           number;
  private minPlayers:       number;
  private maxPlayers:       number;
  private finalRound:       number;

  // Game variables (mirrors Kotlin)
  private round     = 0;
  private waitRound = false;
  private startPlayer = "";

  private playerScores       = new Map<string, number>();
  private playerThirdUmpires = new Map<string, number>();
  private playerDecks        = new Map<string, Deck>();
  private playerDrawnCards   = new Map<string, CricketCard>();
  private playerOuts:          string[] = [];

  private startingTimer:      NodeJS.Timeout | null = null;
  private waitingPlayersTimer: NodeJS.Timeout | null = null;
  private roundTimer:          NodeJS.Timeout | null = null;
  private decisionTimer:       NodeJS.Timeout | null = null;

  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minAmountJoinPot = this.param("amountJoinPot",       500);
    this.amountJoinPot    = this.minAmountJoinPot;
    this.timeToJoinGame   = this.param("timeToJoinGame",       30);   // sec
    this.timeToCancel     = this.param("timeToCancel",          5);   // sec
    this.timeToEndRound   = this.param("timeToEndRound",       20);   // sec
    this.waitBetweenRound = this.param("waitBetweenRound",  5_000);   // ms
    this.idleMs           = this.param("IdleInterval",  1_800_000);
    this.minPlayers       = this.param("minPlayers",            2);
    this.maxPlayers       = this.param("maxPlayers",          200);
    this.finalRound       = this.param("finalRound",            6);

    this.sendChannelMessage(`Bot ${this.botDisplayName} added to room`);
    this.sendChannelMessage(
      `!start to start a game of Cricket. Cost: ${fmt(this.amountJoinPot)} IDR. ` +
      `For custom entry, !start <entry_amount>`
    );
  }

  // ── BotBase abstract implementations ──────────────────────────────────────

  isIdle(): boolean {
    return this.state === BotState.NO_GAME &&
      Date.now() - this.timeLastGameFinished > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state === BotState.NO_GAME;
  }

  stopBot(): void {
    this.endGame(true);
  }

  onUserJoinChannel(username: string): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          `!start to start a game of Cricket. Cost: ${fmt(this.amountJoinPot)} IDR. ` +
          `For custom entry, !start <entry_amount>`,
          username
        );
        break;
      case BotState.GAME_STARTING:
        this.sendMessage(`${username}: Cricket Game is starting soon.`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Play Cricket. Enter !j to join the game. Cost ${fmt(this.amountJoinPot)} IDR.`,
          username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("Cricket is on going now. Get ready for the next game.", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.toLowerCase().trim();

    if (msg === "!start" || (msg.startsWith("!start ") && msg.split(" ").length === 2)) {
      this.startNewGame(username, msg).catch(e => console.error("[cricket]", e));
    } else if (msg === "!n") {
      if (this.startPlayer === username) {
        this.cancelGame(username);
      } else {
        this.sendChannelMessage(`Only ${this.startPlayer} can cancel the pot`);
      }
    } else if (msg === "!j") {
      this.joinGame(username).catch(e => console.error("[cricket]", e));
    } else if (msg === "!d") {
      this.bowl(username, false);
    }
  }

  // ── Game flow ──────────────────────────────────────────────────────────────

  private async startNewGame(username: string, messageText: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME: {
        // Reset amount to default
        this.amountJoinPot = this.minAmountJoinPot;

        // Custom amount: !start <amount>
        if (messageText.length > "!start".length) {
          const parts = messageText.trim().split(/\s+/);
          const parsed = parseFloat(parts[1]);
          if (isNaN(parsed) || parsed <= 0) {
            this.sendMessage("Invalid amount. Custom amount has to be in integer (e.g. !start 5)", username);
            return;
          }
          if (parsed < this.minAmountJoinPot) {
            this.sendMessage(
              `${username}: Invalid amount. Custom amount has to be ${fmt(this.minAmountJoinPot)} or more (e.g. !start 5)`,
              username
            );
            return;
          }
          this.amountJoinPot = parsed;
        }

        if (!(await this.userCanAfford(username, this.amountJoinPot))) return;

        this.startPlayer = username;
        this.state = BotState.GAME_STARTING;

        this.sendMessage(
          `${username}: added to game. Charges apply. ${fmt(this.amountJoinPot)} IDR. ` +
          `Create/enter pot. !n to cancel. ${this.timeToCancel} seconds.`,
          username
        );

        // After timeToCancel seconds, actually start the game
        this.startingTimer = setTimeout(() => {
          this.startingTimer = null;
          this.initGame();
          this.addPlayer(username);

          this.sendChannelMessage(
            `Cricket Game started by ${this.startPlayer}. !j to join. ` +
            `Cost ${fmt(this.amountJoinPot)} IDR. ${this.timeToJoinGame} seconds`
          );
          this.waitForMorePlayers();
        }, this.timeToCancel * 1_000);
        break;
      }
      case BotState.GAME_STARTING:
        this.sendChannelMessage(`${username}: Cricket Game is starting soon.`);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Play Cricket. Enter !j to join the game. Cost ${fmt(this.amountJoinPot)} IDR.`,
          username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("Cricket is on going now. Get ready for the next game.", username);
        break;
    }
  }

  private initGame(): void {
    this.round = 0;
    this.playerScores.clear();
    this.playerThirdUmpires.clear();
    this.playerDecks.clear();
    this.playerDrawnCards.clear();
    this.playerOuts = [];
  }

  private addPlayer(username: string): void {
    this.playerScores.set(username, 0);
    this.playerThirdUmpires.set(username, 0);
    const deck = new Deck();
    deck.init();
    this.playerDecks.set(username, deck);
  }

  private waitForMorePlayers(): void {
    this.sendChannelMessage("Waiting for more players. Enter !j to join the game");
    this.state = BotState.GAME_JOINING;
    this.waitingPlayersTimer = setTimeout(
      () => { this.waitingPlayersTimer = null; this.chargeAndCountPlayers(); },
      this.timeToJoinGame * 1_000
    );
  }

  private async chargeAndCountPlayers(): Promise<void> {
    if (this.state !== BotState.GAME_JOINING) return;

    // Charge all players (mirrors Kotlin pot.enterPlayer)
    const failed: string[] = [];
    for (const player of this.playerScores.keys()) {
      try {
        await this.chargeUser(player, this.amountJoinPot);
      } catch {
        this.sendMessage("Unable to join you to the game", player);
        failed.push(player);
      }
    }
    for (const p of failed) {
      this.playerScores.delete(p);
      this.playerThirdUmpires.delete(p);
      this.playerDecks.delete(p);
    }

    // Track how many were actually charged for payout calculation
    this._chargedPlayers = this.playerScores.size;

    if (this.playerScores.size < this.minPlayers) {
      // Refund survivors
      for (const p of this.playerScores.keys()) {
        await this.refundUser(p, this.amountJoinPot).catch(() => {});
      }
      this.sendChannelMessage(
        `Joining ends. Not enough players. Need ${this.minPlayers}. Enter !start to start a new game.`
      );
      this.resetGame();
      return;
    }

    if (this.playerScores.size > this.maxPlayers) {
      for (const p of this.playerScores.keys()) {
        await this.refundUser(p, this.amountJoinPot).catch(() => {});
      }
      this.sendChannelMessage(
        `Joining ends. Too many players. Max ${this.maxPlayers}. Enter !start to start a new game.`
      );
      this.resetGame();
      return;
    }

    this.state = BotState.PLAYING;
    this.sendChannelMessage("Game begins - Score the most runs!");
    this.nextRound();
  }

  // ── Round flow ─────────────────────────────────────────────────────────────

  private nextRound(): void {
    this.playerDrawnCards.clear();
    this.playerOuts = [];

    this.round++;
    this.waitRound = true;

    this.sendChannelMessage(`Round #${this.round} is starting in 5 seconds`);

    setTimeout(() => {
      this.waitRound = false;
      this.startRound();
    }, this.waitBetweenRound);
  }

  private startRound(): void {
    this.sendChannelMessage(
      `Round ${this.round}: Players, Time to hit. !d to bat. ${this.timeToEndRound} seconds`
    );
    this.roundTimer = setTimeout(() => {
      this.roundTimer = null;
      this.sendChannelMessage("TIME'S UP! Tallying...");
      this.roundEnded();
    }, this.timeToEndRound * 1_000);
  }

  // ── Bowl / Draw ────────────────────────────────────────────────────────────

  private bowl(username: string, botDraw: boolean): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage("Enter !start to start a game", username);
        return;
      case BotState.GAME_STARTING:
        this.sendMessage(`${username}: Cricket Game is starting soon.`, username);
        return;
      case BotState.GAME_JOINING:
        this.sendMessage(`${username}: Game haven't started. Enter !j to join the game`, username);
        return;
      case BotState.PLAYING:
        break;
    }

    if (!this.playerScores.has(username)) {
      this.sendMessage("You are not in the game", username);
      return;
    }

    if (this.waitRound) {
      this.sendMessage(`Round #${this.round} starting. Please wait.`, username);
      return;
    }

    if (this.playerDrawnCards.has(username)) {
      this.sendMessage("You have already drawn ur card. Your turn ends.", username);
      return;
    }

    const deck = this.playerDecks.get(username)!;
    let card = deck.draw();
    if (card === null) {
      deck.init();
      card = deck.draw()!;
    }
    this.playerDrawnCards.set(username, card);
    this.playerDecks.set(username, deck);

    const name  = getCardName(card);
    const type  = getCardType(card);

    // Show card draw message
    if (botDraw) {
      this.sendChannelMessage(`Bot draws - ${username}: ${name}`);
    } else {
      this.sendChannelMessage(`${username}: ${name}`);
    }

    // Handle card effect
    if (type === "O") {
      const umpires = this.playerThirdUmpires.get(username) ?? 0;
      if (umpires <= 0) {
        this.playerOuts.push(username);
        this.sendChannelMessage(`${username}: OUT by ${name}`);
      } else {
        this.playerThirdUmpires.set(username, umpires - 1);
        this.sendChannelMessage(
          `${username}: IMMUNE by Third Umpire. Current turn ends.`
        );
      }
    } else if (type === "U") {
      const umpires = this.playerThirdUmpires.get(username) ?? 0;
      this.playerThirdUmpires.set(username, umpires + 1);
      this.sendChannelMessage(
        `${username}: SAFE by Third Umpire! Immune to next out.`
      );
    } else {
      const runs  = parseInt(type, 10);
      const total = (this.playerScores.get(username) ?? 0) + runs;
      this.playerScores.set(username, total);
    }

    // If all players have drawn and this wasn't a bot-draw, end round early
    if (!botDraw && this.playerDrawnCards.size >= this.playerScores.size) {
      this.sendChannelMessage("Everyone drawn.");
      if (this.roundTimer) { clearTimeout(this.roundTimer); this.roundTimer = null; }
      this.sendChannelMessage("TIME'S UP! Tallying...");
      this.roundEnded();
    }
  }

  // ── Round end ──────────────────────────────────────────────────────────────

  private roundEnded(): void {
    // Auto-draw for players who haven't drawn yet
    for (const username of this.playerScores.keys()) {
      if (!this.playerDrawnCards.has(username)) {
        this.bowl(username, true);
      }
    }

    this.sendChannelMessage("Round over! Results:");

    // If all players are OUT, nobody eliminated (try again)
    if (this.playerOuts.length === this.playerScores.size) {
      this.sendChannelMessage("Nobody won, so we'll try again!");
    } else {
      for (const out of this.playerOuts) {
        this.playerScores.delete(out);
        this.playerDecks.delete(out);
        this.playerThirdUmpires.delete(out);
      }
    }

    // Build sorted tally: "player: +X Runs (total)" or "player: Umpire (total)"
    let tally = new Map<string, number>();
    for (const [player, totalScore] of this.playerScores) {
      const card = this.playerDrawnCards.get(player);
      let msg = "";
      if (!card) {
        msg = `${player}: (${totalScore})`;
      } else {
        const t = getCardType(card);
        if (t === "U") {
          msg = `${player}: Umpire (${totalScore})`;
        } else if (t === "O") {
          msg = `${player}: (${totalScore})`;
        } else {
          const runs = parseInt(t, 10);
          msg = `${player}: +${runs} ${runs === 1 ? "Run" : "Runs"} (${totalScore})`;
        }
      }
      tally.set(msg, totalScore);
    }

    // Sort tally by score descending before sending (mirrors Kotlin GAMES-151 fix)
    tally = sortByValueDesc(tally);
    for (const msg of tally.keys()) {
      this.sendChannelMessage(msg);
    }

    // Continue or resolve
    if (this.round < this.finalRound && this.playerScores.size > 1) {
      this.nextRound();
    } else {
      this.resolveGame();
    }
  }

  // ── Final resolution ───────────────────────────────────────────────────────

  private async resolveGame(): Promise<void> {
    if (this.playerScores.size === 0) {
      this.sendChannelMessage("No more players left in the game. Enter !start to start a new game");
      this.resetGame();
      setTimeout(() => {
        this.sendChannelMessage(
          `!start to start a game of Cricket. Cost: ${fmt(this.minAmountJoinPot)} IDR. ` +
          `For custom entry, !start <entry_amount>`
        );
      }, 5_000);
      return;
    }

    // Sort descending and find highest score
    this.playerScores = sortByValueDesc(this.playerScores);
    const highestScore = [...this.playerScores.values()][0];

    // Remove players below highest score
    const toRemove: string[] = [];
    for (const [player, score] of this.playerScores) {
      if (score < highestScore) toRemove.push(player);
    }
    for (const p of toRemove) {
      this.playerScores.delete(p);
      this.playerDecks.delete(p);
      this.playerThirdUmpires.delete(p);
    }

    // Tie — continue with another round
    if (this.playerScores.size > 1) {
      const tied = [...this.playerScores.keys()].join(", ");
      this.sendChannelMessage(
        `There is a tie. ${this.playerScores.size} left in the game [${tied}]`
      );
      this.nextRound();
      return;
    }

    // Single winner
    if (this.playerScores.size === 1) {
      const winner = [...this.playerScores.keys()][0];
      this.sendChannelMessage(`${winner} is the last player in.`);

      const totalPot = this.computeTotalPot();
      await this.creditUser(winner, totalPot).catch(() => {});

      this.sendChannelMessage(
        `Cricket Game over! ${winner} WINS ${fmt(totalPot)} IDR! CONGRATS!`
      );
      this.sendChannelMessage("Enter !start to start a game");
      this.resetGame();
      setTimeout(() => {
        this.sendChannelMessage(
          `!start to start a game of Cricket. Cost: ${fmt(this.minAmountJoinPot)} IDR. ` +
          `For custom entry, !start <entry_amount>`
        );
      }, 5_000);
    }
  }

  // ── Join / Cancel ──────────────────────────────────────────────────────────

  private async joinGame(username: string): Promise<void> {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage("Enter !start to start a game", username);
        break;
      case BotState.GAME_STARTING:
        this.sendMessage(`${username}: Cricket Game is starting soon.`, username);
        break;
      case BotState.GAME_JOINING:
        if (this.playerScores.has(username)) {
          this.sendMessage(
            "You have already joined the game. Please wait for the game to start",
            username
          );
        } else if (this.playerScores.size + 1 > this.maxPlayers) {
          this.sendMessage(
            `Too many players joined the game. Max ${this.maxPlayers} players. Please wait for the next game.`,
            username
          );
        } else if (!(await this.userCanAfford(username, this.amountJoinPot))) {
          // userCanAfford sends pvt message itself
        } else {
          this.addPlayer(username);
          this.sendChannelMessage(`${username} joined the game`);

          // If max players hit, start immediately
          if (this.playerScores.size >= this.maxPlayers && this.waitingPlayersTimer) {
            clearTimeout(this.waitingPlayersTimer);
            this.waitingPlayersTimer = null;
            this.chargeAndCountPlayers();
          }
        }
        break;
      case BotState.PLAYING:
        this.sendMessage(
          "A game is currently in progress. Please wait for next game",
          username
        );
        break;
    }
  }

  private cancelGame(username: string): void {
    if (this.state !== BotState.GAME_STARTING) {
      this.sendChannelMessage("Invalid command.");
      return;
    }

    if (this.startingTimer) { clearTimeout(this.startingTimer); this.startingTimer = null; }

    this.state = BotState.NO_GAME;
    this.amountJoinPot = this.minAmountJoinPot;

    this.sendMessage(`${username}: You were not charged.`, username);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Total pot = number of players × entry amount.
   * Called just before payout so playerScores still contains all active players.
   */
  private computeTotalPot(): number {
    return this._chargedPlayers * this.amountJoinPot;
  }

  // Track how many players were actually charged (set in chargeAndCountPlayers)
  private _chargedPlayers = 0;

  private endGame(cancelPot: boolean): void {
    if (this.state === BotState.NO_GAME) return;

    if (cancelPot) {
      // Refund all players who were charged
      for (const player of this.playerScores.keys()) {
        this.refundUser(player, this.amountJoinPot).catch(() => {});
      }
    }

    this.resetGame();
  }

  private resetGame(): void {
    if (this.startingTimer)      { clearTimeout(this.startingTimer);      this.startingTimer      = null; }
    if (this.waitingPlayersTimer){ clearTimeout(this.waitingPlayersTimer); this.waitingPlayersTimer = null; }
    if (this.roundTimer)         { clearTimeout(this.roundTimer);          this.roundTimer          = null; }
    if (this.decisionTimer)      { clearTimeout(this.decisionTimer);       this.decisionTimer       = null; }

    this.timeLastGameFinished = Date.now();
    this.state         = BotState.NO_GAME;
    this.round         = 0;
    this.waitRound     = false;
    this.startPlayer   = "";
    this.amountJoinPot = this.minAmountJoinPot;
    this._chargedPlayers = 0;

    this.playerScores.clear();
    this.playerThirdUmpires.clear();
    this.playerDecks.clear();
    this.playerDrawnCards.clear();
    this.playerOuts = [];
  }

  protected clearAllTimers(): void {
    this.resetGame();
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "cricket",
  displayName: "Cricket",
  description: "Game kartu kriket — kumpulkan skor tertinggi.",
  category: "sports",
  factory: ctx => new Cricket(ctx),
});
