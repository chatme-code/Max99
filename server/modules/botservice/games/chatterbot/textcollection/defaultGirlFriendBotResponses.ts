import { TextCollection } from "../textCollection";

export class DefaultGirlFriendBotResponses extends TextCollection {
  constructor() {
    super("defaultgf", "Default GirlFriendBot Responses");
    this.loadTexts([
      "Aww, that's so sweet of you to say!",
      "Really? Tell me more!",
      "I totally understand how you feel.",
      "That's so interesting! I never thought of it that way.",
      "Haha, you always make me smile!",
      "That's such a great point!",
      "Oh wow, really?",
      "I feel the same way!",
      "You're so thoughtful!",
      "I'm here for you, always.",
    ]);
  }
}
