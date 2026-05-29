import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

function fmt(n: number): string { return Math.round(n).toString(); }

interface TriviaQ {
  q: string;
  options: string[];
  answer: number;
  category: string;
}

const QUESTIONS: TriviaQ[] = [
  { category: "Science", q: "What planet is known as the Red Planet?", options: ["A. Venus", "B. Mars", "C. Jupiter", "D. Saturn"], answer: 1 },
  { category: "Science", q: "What is the chemical symbol for water?", options: ["A. WA", "B. HO", "C. H2O", "D. WO2"], answer: 2 },
  { category: "Science", q: "How many bones are in the human body?", options: ["A. 106", "B. 206", "C. 306", "D. 406"], answer: 1 },
  { category: "Science", q: "What is the speed of light (approx)?", options: ["A. 100,000 km/s", "B. 200,000 km/s", "C. 300,000 km/s", "D. 400,000 km/s"], answer: 2 },
  { category: "Geography", q: "What is the capital of France?", options: ["A. London", "B. Berlin", "C. Paris", "D. Rome"], answer: 2 },
  { category: "Geography", q: "Which is the largest continent?", options: ["A. Africa", "B. Asia", "C. Europe", "D. Americas"], answer: 1 },
  { category: "Geography", q: "What is the longest river in the world?", options: ["A. Amazon", "B. Yangtze", "C. Nile", "D. Mississippi"], answer: 2 },
  { category: "Geography", q: "Which country has the most population?", options: ["A. India", "B. China", "C. USA", "D. Russia"], answer: 1 },
  { category: "History", q: "In what year did World War II end?", options: ["A. 1943", "B. 1944", "C. 1945", "D. 1946"], answer: 2 },
  { category: "History", q: "Who was the first US President?", options: ["A. Lincoln", "B. Jefferson", "C. Washington", "D. Adams"], answer: 2 },
  { category: "History", q: "In what year did the Berlin Wall fall?", options: ["A. 1987", "B. 1988", "C. 1989", "D. 1990"], answer: 2 },
  { category: "Pop Culture", q: "Who wrote Harry Potter?", options: ["A. Tolkien", "B. Rowling", "C. Lewis", "D. King"], answer: 1 },
  { category: "Pop Culture", q: "What country does K-pop originate from?", options: ["A. Japan", "B. China", "C. South Korea", "D. Thailand"], answer: 2 },
  { category: "Pop Culture", q: "Which band wrote 'Bohemian Rhapsody'?", options: ["A. The Beatles", "B. Led Zeppelin", "C. Queen", "D. Pink Floyd"], answer: 2 },
  { category: "Math", q: "What is 15 × 15?", options: ["A. 200", "B. 215", "C. 225", "D. 250"], answer: 2 },
  { category: "Math", q: "What is the square root of 144?", options: ["A. 10", "B. 11", "C. 12", "D. 13"], answer: 2 },
  { category: "Math", q: "How many degrees in a right angle?", options: ["A. 45", "B. 90", "C. 180", "D. 360"], answer: 1 },
  { category: "Nature", q: "What gas do plants absorb from the air?", options: ["A. Oxygen", "B. Nitrogen", "C. Carbon Dioxide", "D. Hydrogen"], answer: 2 },
  { category: "Nature", q: "How many legs does a spider have?", options: ["A. 6", "B. 8", "C. 10", "D. 12"], answer: 1 },
  { category: "Sports", q: "How many players are in a soccer team?", options: ["A. 9", "B. 10", "C. 11", "D. 12"], answer: 2 },
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Trivia extends BotBase {
  readonly gameType = "trivia";

  private minPlayers:       number;
  private maxPlayers:       number;
  private waitForPlayerMs:  number;
  private answerTimeMs:     number;
  private betweenQMs:       number;
  private idleMs:           number;
  private minCostToJoin:    number;
  private maxCostToJoin:    number;
  private questionsPerGame: number;

  private costToJoin = 0;
  private players: string[] = [];
  private scores = new Map<string, number>();
  private answers = new Map<string, number>();
  private questionQueue: TriviaQ[] = [];
  private currentQ: TriviaQ | null = null;
  private questionIndex = 0;
  private waitTimer: NodeJS.Timeout | null = null;
  private qTimer:    NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers       = this.param("MinPlayers", 2);
    this.maxPlayers       = this.param("MaxPlayers", 20);
    this.waitForPlayerMs  = this.param("TimeToJoinGame", 60_000);
    this.answerTimeMs     = this.param("AnswerTime", 20_000);
    this.betweenQMs       = this.param("TimeBetweenQuestions", 5_000);
    this.idleMs           = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin    = this.param("MinCostToJoinGame", 500);
    this.maxCostToJoin    = this.param("MaxCostToJoinGame", 50_000);
    this.questionsPerGame = this.param("QuestionsPerGame", 10);

    this.sendChannelMessage(
      `Bot Trivia added. !start to play. Min entry: IDR ${fmt(this.minCostToJoin)}. ` +
      "Answer with !a, !b, !c or !d."
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
        this.sendMessage(`Play Trivia. !start to start. Min entry: IDR ${fmt(this.minCostToJoin)}`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`Trivia forming. !j to join. Entry: IDR ${fmt(this.costToJoin)}`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("Trivia in progress. Wait for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const lower = text.toLowerCase().trim();
    if (lower.startsWith("!start")) { this.startNewGame(username, lower).catch(e => console.error("[trivia]", e)); return; }
    if (lower === "!j") { this.joinGame(username).catch(e => console.error("[trivia]", e)); return; }
    if (lower === "!a" || lower === "!1") { this.submitAnswer(username, 0); return; }
    if (lower === "!b" || lower === "!2") { this.submitAnswer(username, 1); return; }
    if (lower === "!c" || lower === "!3") { this.submitAnswer(username, 2); return; }
    if (lower === "!d" || lower === "!4") { this.submitAnswer(username, 3); return; }
    if (lower === "!score") { this.showScores(username); return; }
    this.sendMessage(`${text} is not a valid command. Answer: !a !b !c !d`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `Trivia forming. !j to join. Entry: IDR ${fmt(this.costToJoin)}`
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
    this.players = [username];
    this.scores.clear();
    this.scores.set(username, 0);
    this.sendChannelMessage(`${username} started Trivia!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: IDR ${fmt(this.minCostToJoin)}`, username); return;
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
    this.sendChannelMessage(`${username} joined Trivia`);
  }

  private submitAnswer(username: string, idx: number): void {
    if (this.state !== BotState.PLAYING || !this.currentQ) {
      this.sendMessage("No active question", username); return;
    }
    if (!this.players.includes(username)) {
      this.sendMessage("You are not in the game", username); return;
    }
    if (this.answers.has(username)) {
      this.sendMessage("You already answered this question", username); return;
    }
    this.answers.set(username, idx);
    const letter = ["A", "B", "C", "D"][idx];
    this.sendChannelMessage(`${username} answered ${letter}`);
    if (this.answers.size >= this.players.length) {
      if (this.qTimer) clearTimeout(this.qTimer);
      this.qTimer = setTimeout(() => this.revealAnswer(), 1000);
    }
  }

  private showScores(username: string): void {
    const lines = [...this.scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, s]) => `${p}: ${s}`).join(", ");
    this.sendMessage(`Scores: ${lines}`, username);
  }

  private waitForPlayers(): void {
    this.state = BotState.GAME_JOINING;
    this.sendChannelMessage(
      `Waiting for players. !j to join. Entry: IDR ${fmt(this.costToJoin)}. ` +
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
    this.questionQueue = shuffle(QUESTIONS).slice(0, this.questionsPerGame);
    this.questionIndex = 0;
    this.sendChannelMessage(
      `Trivia starts! ${this.players.length} players, ${this.questionQueue.length} questions. ` +
      `Answer with !a !b !c !d. !score for standings.`
    );
    this.askQuestion();
  }

  private askQuestion(): void {
    if (this.questionIndex >= this.questionQueue.length) {
      this.endGame();
      return;
    }
    this.currentQ = this.questionQueue[this.questionIndex++];
    this.answers.clear();
    this.sendChannelMessage(
      `Q${this.questionIndex} [${this.currentQ.category}]: ${this.currentQ.q} ` +
      `| ${this.currentQ.options.join("  ")} — ${Math.round(this.answerTimeMs / 1000)}s`
    );
    this.qTimer = setTimeout(() => this.revealAnswer(), this.answerTimeMs);
  }

  private revealAnswer(): void {
    this.qTimer = null;
    if (!this.currentQ) return;
    const q = this.currentQ;
    const letter = ["A", "B", "C", "D"][q.answer];
    const correct: string[] = [];
    for (const [player, idx] of this.answers) {
      if (idx === q.answer) {
        correct.push(player);
        this.scores.set(player, (this.scores.get(player) ?? 0) + 1);
      }
    }
    const noAnswer = this.players.filter(p => !this.answers.has(p));
    this.sendChannelMessage(
      `Answer: ${letter}. ${q.options[q.answer]}. ` +
      (correct.length > 0 ? `Correct: [${correct.join(", ")}]` : "No one got it right!") +
      (noAnswer.length > 0 ? ` | No answer: [${noAnswer.join(", ")}]` : "")
    );
    this.qTimer = setTimeout(() => this.askQuestion(), this.betweenQMs);
  }

  private async endGame(): Promise<void> {
    const sorted = [...this.scores.entries()].sort((a, b) => b[1] - a[1]);
    this.sendChannelMessage("Trivia over! Final scores:");
    for (const [p, s] of sorted) {
      this.sendChannelMessage(`  ${p}: ${s} pts`);
    }
    const maxScore = sorted[0][1];
    const winners = sorted.filter(([, s]) => s === maxScore).map(([p]) => p);
    const pot = this.players.length * this.costToJoin;
    const share = winners.length > 0 ? pot / winners.length : 0;
    for (const w of winners) {
      if (share > 0) await this.creditUser(w, share).catch(() => {});
    }
    this.sendChannelMessage(
      `Winner${winners.length > 1 ? "s" : ""}: ${winners.join(", ")} with ${maxScore} pts` +
      (share > 0 ? ` — IDR ${fmt(share)} each` : "") +
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
    this.answers.clear();
    this.currentQ = null;
    this.questionIndex = 0;
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "trivia",
  displayName: "Trivia",
  description: "Uji pengetahuanmu dengan pertanyaan trivia berbagai kategori.",
  category: "social",
  factory: ctx => new Trivia(ctx),
});
