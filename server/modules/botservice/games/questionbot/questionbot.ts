import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

interface Question {
  q: string;
  keywords: string[];
  answer: string;
}

const QA: Question[] = [
  { q: "What does HTML stand for?", keywords: ["hypertext","markup","language"], answer: "HyperText Markup Language" },
  { q: "What is the capital of Japan?", keywords: ["tokyo"], answer: "Tokyo" },
  { q: "Who invented the telephone?", keywords: ["bell","alexander"], answer: "Alexander Graham Bell" },
  { q: "What is the largest planet in the solar system?", keywords: ["jupiter"], answer: "Jupiter" },
  { q: "How many sides does a hexagon have?", keywords: ["6","six"], answer: "6" },
  { q: "What gas do humans exhale?", keywords: ["carbon","dioxide","co2"], answer: "Carbon Dioxide (CO2)" },
  { q: "Who painted the Mona Lisa?", keywords: ["da vinci","davinci","leonardo"], answer: "Leonardo da Vinci" },
  { q: "What year did the first moon landing happen?", keywords: ["1969"], answer: "1969" },
  { q: "What is the fastest land animal?", keywords: ["cheetah"], answer: "Cheetah" },
  { q: "What is 7 x 8?", keywords: ["56"], answer: "56" },
  { q: "What language is spoken in Brazil?", keywords: ["portuguese"], answer: "Portuguese" },
  { q: "What is H2O?", keywords: ["water"], answer: "Water" },
  { q: "How many continents are there?", keywords: ["7","seven"], answer: "7" },
  { q: "What is the tallest mountain in the world?", keywords: ["everest"], answer: "Mount Everest" },
  { q: "In what country is the Great Wall?", keywords: ["china"], answer: "China" },
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class QuestionBot extends BotBase {
  readonly gameType = "questionbot";

  private minPlayers:      number;
  private maxPlayers:      number;
  private waitForPlayerMs: number;
  private answerTimeMs:    number;
  private betweenQMs:      number;
  private idleMs:          number;
  private minCostToJoin:   number;
  private maxCostToJoin:   number;
  private questionsPerGame: number;

  private costToJoin = 0;
  private players: string[] = [];
  private scores = new Map<string, number>();
  private firstAnswered: string | null = null;
  private currentQ: Question | null = null;
  private questionQueue: Question[] = [];
  private questionIndex = 0;
  private waitTimer:  NodeJS.Timeout | null = null;
  private qTimer:     NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers       = this.param("MinPlayers", 2);
    this.maxPlayers       = this.param("MaxPlayers", 20);
    this.waitForPlayerMs  = this.param("TimeToJoinGame", 60_000);
    this.answerTimeMs     = this.param("AnswerTime", 25_000);
    this.betweenQMs       = this.param("TimeBetweenQuestions", 5_000);
    this.idleMs           = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin    = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin    = this.param("MaxCostToJoinGame", 500);
    this.questionsPerGame = this.param("QuestionsPerGame", 10);

    this.sendChannelMessage(
      `Bot QuestionBot added. !start to play. Min entry: ${this.minCostToJoin.toFixed(2)} credits. ` +
      "Answer questions by typing! First correct answer wins the point."
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
        this.sendMessage(`Play QuestionBot. !start to start. Min entry: ${this.minCostToJoin.toFixed(2)} credits`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`QuestionBot forming. !j to join. Entry: ${this.costToJoin.toFixed(2)} credits`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("QuestionBot in progress. Wait for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const lower = text.toLowerCase().trim();
    if (lower.startsWith("!start")) { this.startNewGame(username, lower).catch(e => console.error("[questionbot]", e)); return; }
    if (lower === "!j") { this.joinGame(username).catch(e => console.error("[questionbot]", e)); return; }
    if (lower === "!score") { this.showScores(username); return; }
    if (this.state === BotState.PLAYING && this.currentQ && !this.firstAnswered) {
      this.checkAnswer(username, text);
    }
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `QuestionBot forming. !j to join. Entry: ${this.costToJoin.toFixed(2)} credits`
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
      if (parsed < this.minCostToJoin) { this.sendMessage(`Minimum entry is ${this.minCostToJoin.toFixed(2)} credits`, username); return; }
      if (rawInput > this.maxCostToJoin) { this.sendMessage(`Maximum bet is ${this.maxCostToJoin} IDR`, username); return; }
      cost = parsed;
    }
    if (!(await this.userCanAfford(username, cost))) return;
    await this.chargeUser(username, cost);
    this.costToJoin = cost;
    this.players = [username];
    this.scores.clear();
    this.scores.set(username, 0);
    this.sendChannelMessage(`${username} started QuestionBot!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: ${this.minCostToJoin.toFixed(2)} credits`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Wait for next game", username); return;
    }
    if (this.players.includes(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.players.length >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.players.push(username);
    this.scores.set(username, 0);
    this.sendChannelMessage(`${username} joined QuestionBot`);
  }

  private checkAnswer(username: string, text: string): void {
    if (!this.players.includes(username)) return;
    const lower = text.toLowerCase();
    const q = this.currentQ!;
    const correct = q.keywords.some(k => lower.includes(k));
    if (correct) {
      this.firstAnswered = username;
      if (this.qTimer) clearTimeout(this.qTimer);
      this.scores.set(username, (this.scores.get(username) ?? 0) + 1);
      this.sendChannelMessage(
        `Correct! ${username} gets the point! Answer: ${q.answer}. ` +
        `${username} now has ${this.scores.get(username)} pts.`
      );
      this.qTimer = setTimeout(() => this.askQuestion(), this.betweenQMs);
    }
  }

  private showScores(username: string): void {
    const lines = [...this.scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, s]) => `${p}:${s}`).join(", ");
    this.sendMessage(`Scores: ${lines}`, username);
  }

  private waitForPlayers(): void {
    this.state = BotState.GAME_JOINING;
    this.sendChannelMessage(
      `Waiting for players. !j to join. Entry: ${this.costToJoin.toFixed(2)} credits. ` +
      `${Math.round(this.waitForPlayerMs / 1000)}s to join.`
    );
    this.waitTimer = setTimeout(() => this.beginGame(), this.waitForPlayerMs);
  }

  private async beginGame(): Promise<void> {
    this.waitTimer = null;
    if (this.players.length < this.minPlayers) {
      await this.refundAll();
      this.resetGame();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.state = BotState.PLAYING;
    this.questionQueue = shuffle(QA).slice(0, this.questionsPerGame);
    this.questionIndex = 0;
    this.sendChannelMessage(
      `QuestionBot starts! ${this.players.length} players, ${this.questionQueue.length} questions. ` +
      `Type the answer first to get the point! !score for standings.`
    );
    this.askQuestion();
  }

  private askQuestion(): void {
    if (this.questionIndex >= this.questionQueue.length) {
      this.endGame();
      return;
    }
    this.currentQ = this.questionQueue[this.questionIndex++];
    this.firstAnswered = null;
    this.sendChannelMessage(
      `Q${this.questionIndex}: ${this.currentQ.q} — ` +
      `${Math.round(this.answerTimeMs / 1000)}s to answer!`
    );
    this.qTimer = setTimeout(() => {
      this.sendChannelMessage(`Time's up! Answer: ${this.currentQ!.answer}`);
      this.qTimer = setTimeout(() => this.askQuestion(), this.betweenQMs);
    }, this.answerTimeMs);
  }

  private async endGame(): Promise<void> {
    const sorted = [...this.scores.entries()].sort((a, b) => b[1] - a[1]);
    this.sendChannelMessage("QuestionBot over! Final scores:");
    for (const [p, s] of sorted) this.sendChannelMessage(`  ${p}: ${s} pts`);
    const maxScore = sorted[0][1];
    const winners = sorted.filter(([, s]) => s === maxScore).map(([p]) => p);
    const pot = this.players.length * this.costToJoin;
    const share = winners.length > 0 ? pot / winners.length : 0;
    for (const w of winners) {
      if (share > 0) await this.refundUser(w, share).catch(() => {});
    }
    this.sendChannelMessage(
      `Winner${winners.length > 1 ? "s" : ""}: ${winners.join(", ")} with ${maxScore} pts` +
      (share > 0 ? ` — ${share.toFixed(2)} credits each` : "") +
      ". Enter !start to play again"
    );
    this.resetGame();
  }

  private async refundAll(): Promise<void> {
    for (const player of this.players) {
      if (this.costToJoin > 0) await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.players = [];
    this.scores.clear();
    this.currentQ = null;
    this.firstAnswered = null;
    this.questionIndex = 0;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "questionbot",
  displayName: "Question Bot",
  description: "Bot tanya jawab — jawab pertanyaan untuk menang.",
  category: "social",
  factory: ctx => new QuestionBot(ctx),
});
