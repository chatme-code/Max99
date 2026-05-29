import { TextCollection } from "../textCollection";

export class DefaultBoyFriendBotResponses extends TextCollection {
  constructor() {
    super("defaultbf", "Default BoyFriendBot Responses");
    this.loadTexts([
      "Hey, that's interesting! Tell me more.",
      "I'm all ears, babe.",
      "Cool, I like the way you think!",
      "Haha, you crack me up!",
      "That's pretty deep, I'll think about it.",
      "No way! Really?",
      "I'm with you on that one.",
      "Ha, you're funny!",
      "I hear you. Keep talking, I'm listening.",
      "Interesting... very interesting.",
    ]);
  }
}
