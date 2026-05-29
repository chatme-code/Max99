import { Text } from "./text";

export abstract class TextCollection {
  protected texts: Text[] = [];
  private nextIndex  = 0;
  private shuffled   = false;

  constructor(
    public readonly code:        string,
    public readonly displayName: string
  ) {}

  getNextText(): Text {
    if (!this.shuffled) {
      this.shuffle();
      this.shuffled = true;
    }
    const next = this.texts[this.nextIndex];
    this.nextIndex++;
    if (this.nextIndex >= this.texts.length) {
      this.shuffle();
      this.nextIndex = 0;
    }
    return next;
  }

  protected loadTexts(items: string[]): void {
    this.texts = items.map((content, i) => new Text(i + 1, content));
  }

  private shuffle(): void {
    for (let i = this.texts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.texts[i], this.texts[j]] = [this.texts[j], this.texts[i]];
    }
  }
}
