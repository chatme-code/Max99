import { TextCollection } from "../textCollection";

export class InspirationalQuoteIntros extends TextCollection {
  constructor() {
    super("ii_intro", "Inspirational Quote Intros");
    this.loadTexts([
      "USERNAME, here's an inspirational quote to brighten your day: TEXT",
      "For you USERNAME, a little inspiration: TEXT",
      "USERNAME, let these words lift your spirit: TEXT",
      "A thought for you USERNAME: TEXT",
      "USERNAME, words of wisdom: TEXT",
      "Inspiration for USERNAME: TEXT",
      "USERNAME, I hope this quote moves you: TEXT",
      "Here's something meaningful for you USERNAME: TEXT",
    ]);
  }
}
