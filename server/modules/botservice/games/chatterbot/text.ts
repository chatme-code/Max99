export class Text {
  constructor(
    public readonly id:      number,
    public readonly content: string
  ) {}

  toString(): string {
    return `Text [id=${this.id}, content=${this.content}]`;
  }
}
