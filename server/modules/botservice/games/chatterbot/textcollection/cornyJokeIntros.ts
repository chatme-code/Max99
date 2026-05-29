import { TextCollection } from "../textCollection";

export class CornyJokeIntros extends TextCollection {
  constructor() {
    super("cj_intros", "Corny Joke Intros");
    this.loadTexts([
      "USERNAME, here's a corny joke just for you: TEXT",
      "Haha USERNAME, get ready to groan... TEXT",
      "USERNAME asked for a corny joke so here goes: TEXT",
      "Brace yourself USERNAME... TEXT",
      "USERNAME, this one's for you: TEXT",
      "OK USERNAME, don't blame me for this one... TEXT",
      "USERNAME requested a joke! Here it is: TEXT",
      "Drumroll please for USERNAME... TEXT",
    ]);
  }
}
