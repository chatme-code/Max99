import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

interface ChatPattern { pattern: RegExp; responses: string[]; }

const PATTERNS: ChatPattern[] = [
  { pattern: /\b(hi|hello|hey|sup|yo)\b/i,             responses: ["Hey there! How's it going?", "Hi! Nice to see you!", "Hello! What's up?", "Hey! Glad you're here."] },
  { pattern: /\bhow are you\b/i,                        responses: ["I'm doing great, thanks for asking!", "Feeling awesome today!", "Pretty good! And you?", "Fantastic, ready to chat!"] },
  { pattern: /\b(bye|goodbye|cya|later|ttyl)\b/i,       responses: ["See you later!", "Bye! Come back soon!", "Later, take care!", "Goodbye! It was fun chatting!"] },
  { pattern: /\bwhat.*name\b/i,                         responses: ["I'm your friendly bot! Nice to meet you.", "They call me Bot!", "I'm a bot, here to chat!"] },
  { pattern: /\b(joke|funny|laugh)\b/i,                 responses: ["Why don't scientists trust atoms? Because they make up everything!", "What do you call a fish with no eyes? A fsh!", "Why did the math book look sad? It had too many problems."] },
  { pattern: /\b(bored|boring)\b/i,                     responses: ["Let me entertain you! Try a command.", "Boredom is just the mind waiting for inspiration.", "How about trying one of my special commands?"] },
  { pattern: /\b(cool|awesome|great|nice|wow)\b/i,      responses: ["Totally agree!", "Right?! So cool!", "Amazing isn't it!", "I know, right?!"] },
  { pattern: /\b(sad|upset|unhappy|depressed)\b/i,      responses: ["Aw, I'm sorry to hear that. Cheer up!", "It'll get better! I believe in you.", "Want to talk about it? I'm here!"] },
  { pattern: /\b(happy|excited|glad|yay)\b/i,           responses: ["Yay, love the energy!", "That's wonderful to hear!", "You're making me happy too!"] },
  { pattern: /\b(love|like|adore)\b/i,                  responses: ["Aww, that's sweet!", "Love is in the air!", "That's so wholesome!"] },
  { pattern: /\b(food|eat|hungry|pizza|burger)\b/i,     responses: ["Mmm, sounds delicious!", "I wish I could eat!", "Is it lunch time already?", "Food talk — my favourite!"] },
  { pattern: /\b(music|song|sing|listen)\b/i,           responses: ["Music is the language of the soul!", "What genre do you like?", "I'd sing if I could!"] },
];

const DEFAULT_RESPONSES = [
  "That's interesting, tell me more!",
  "Hmm, I'm not sure about that.",
  "I didn't quite catch that!",
  "Fascinating!",
  "Sounds good!",
  "Oh really?",
  "Ha, I didn't expect that!",
  "Let me think about that...",
  "Is that so?",
  "You don't say!",
];

export abstract class ChatterBot extends BotBase {
  protected idleMs:                   number;
  protected timeLastMessageReceived = Date.now();
  protected timeLastUserJoined      = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.idleMs = this.param("IdleInterval", 1_800_000);
    this.state  = BotState.NO_GAME;
  }

  isIdle(): boolean {
    return Date.now() - this.timeLastMessageReceived > this.idleMs;
  }

  canBeStoppedNow(): boolean { return true; }

  stopBot(): void {
    this.sendChannelMessage("Bye for now. Talk to you later...");
  }

  onUserJoinChannel(username: string): void {
    this.timeLastUserJoined = Date.now();
  }

  onUserLeaveChannel(username: string): void {}

  onMessage(username: string, text: string, ts: number): void {
    this.timeLastMessageReceived = Date.now();
    for (const { pattern, responses } of PATTERNS) {
      if (pattern.test(text)) {
        this.sendMessage(this.pickRandom(responses), username);
        return;
      }
    }
    this.sendMessage(this.pickRandom(DEFAULT_RESPONSES), username);
  }

  protected pickRandom(responses: string[]): string {
    return responses[Math.floor(Math.random() * responses.length)];
  }
}

import { gameRegistry } from "../../GameRegistry";
gameRegistry.register({
  name: "chatterbot",
  displayName: "Chatter Bot",
  description: "Bot obrolan AI — ajak ngobrol dan berikan respons otomatis.",
  category: "chatterbot",
  factory: ctx => new ChatterBot(ctx),
});
