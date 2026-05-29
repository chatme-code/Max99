export { Card, Rank, Suit } from "../common/card";
import { Card, Rank, Suit } from "../common/card";

export function newShuffledDeck(): Card[] {
  return Card.newShuffledDeck();
}

function rankDisplay(r: Rank): string {
  if (r === Rank.TEN)   return "10";
  if (r === Rank.JACK)  return "J";
  if (r === Rank.QUEEN) return "Q";
  if (r === Rank.KING)  return "K";
  if (r === Rank.ACE)   return "A";
  return r as string;
}

function suitDisplay(s: Suit): string {
  switch (s) {
    case Suit.CLUBS:    return "\u2663";
    case Suit.DIAMONDS: return "\u2666";
    case Suit.HEARTS:   return "\u2665";
    case Suit.SPADES:   return "\u2660";
  }
}

export function cardStr(c: Card): string {
  return rankDisplay(c.rank()) + suitDisplay(c.suit());
}

export class Hand {
  private cards: Card[] = [];

  add(card: Card): void { this.cards.push(card); }

  clear(): void { this.cards = []; }

  get size(): number { return this.cards.length; }

  at(index: number): Card { return this.cards[index]; }

  count(): number {
    let sum = 0;
    for (const c of this.cards) {
      switch (c.rank()) {
        case Rank.ACE:                                         sum += 1; break;
        case Rank.DEUCE:                                       sum += 2; break;
        case Rank.THREE:                                       sum += 3; break;
        case Rank.FOUR:                                        sum += 4; break;
        case Rank.FIVE:                                        sum += 5; break;
        case Rank.SIX:                                         sum += 6; break;
        case Rank.SEVEN:                                       sum += 7; break;
        case Rank.EIGHT:                                       sum += 8; break;
        case Rank.NINE:                                        sum += 9; break;
        case Rank.TEN: case Rank.JACK: case Rank.QUEEN: case Rank.KING: break;
      }
    }
    return sum % 10;
  }

  toString(): string {
    const cardsStr = this.cards.map(c => cardStr(c)).join(" ");
    const count    = this.count();
    const natural  = count >= 8 && this.cards.length === 2 ? "Natural " : "";
    return `${cardsStr} ${natural}${count}`;
  }
}
