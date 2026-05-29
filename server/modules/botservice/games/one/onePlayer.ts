import { Card, BLUE, GREEN, RED, YELLOW, WILD_COLOR, WILD, WILD_DRAW_4, REVERSE, DRAW_2, SKIP } from "./oneCard";

export class Player {
  private name:     string;
  private cards:    Card[] = [];
  calledUno = false;

  constructor(name: string) {
    this.name = name;
  }

  getName():  string   { return this.name; }
  setName(n: string):  void { this.name = n; }
  getCards(): Card[]   { return this.cards; }

  addCard(card: Card | null): void {
    if (!card) return;
    this.cards.push(card);
  }

  removeCard(card: Card): void {
    const idx = this.cards.findIndex(c => c.equals(card));
    if (idx !== -1) this.cards.splice(idx, 1);
  }

  setCalledUno(called: boolean): void { this.calledUno = called; }
  hasCalledUno(): boolean { return this.calledUno; }

  toString(): string {
    const cardList = this.cards.map(c => c.toString()).join(" ");
    return `${this.name}: (${this.cards.length} cards) ${cardList}`;
  }

  getHand(): Card[] {
    const blue:   Card[] = [];
    const green:  Card[] = [];
    const red:    Card[] = [];
    const yellow: Card[] = [];
    const wild:   Card[] = [];

    for (const card of this.cards) {
      switch (card.getColour()) {
        case BLUE:       blue.push(card);   break;
        case GREEN:      green.push(card);  break;
        case RED:        red.push(card);    break;
        case YELLOW:     yellow.push(card); break;
        case WILD_COLOR: wild.push(card);   break;
      }
    }
    for (const arr of [blue, green, red, yellow, wild]) {
      arr.sort((a, b) => a.compareTo(b));
    }
    return [...blue, ...green, ...red, ...yellow, ...wild];
  }

  getCard(cardValue: number, cardColour: number): Card | null {
    for (const card of this.cards) {
      const matchWild   = card.getValue() === WILD        && cardValue === WILD;
      const matchWD4    = card.getValue() === WILD_DRAW_4 && cardValue === WILD_DRAW_4;
      const matchExact  = card.getColour() === cardColour && card.getValue() === cardValue;
      if (matchExact || matchWild || matchWD4) return card;
    }
    return null;
  }

  hasCardWithValue(cardValue: number): boolean {
    return this.cards.some(c =>
      c.getValue() === cardValue ||
      c.getValue() === WILD ||
      c.getValue() === WILD_DRAW_4
    );
  }

  hasCardWithColour(cardColour: number): boolean {
    return this.cards.some(c => c.getColour() === cardColour);
  }

  getPoints(): number {
    let score = 0;
    for (const card of this.cards) {
      const v = card.getValue();
      if (v === REVERSE || v === SKIP || v === DRAW_2) {
        score += 20;
      } else if (v === WILD || v === WILD_DRAW_4) {
        score += 50;
      } else {
        score += v;
      }
    }
    return score;
  }

  isLastCard(): boolean { return this.cards.length === 1; }
  hasUno():     boolean { return this.cards.length === 1; }
  hasWon():     boolean { return this.cards.length === 0; }
  cardCount():  number  { return this.cards.length; }
}
