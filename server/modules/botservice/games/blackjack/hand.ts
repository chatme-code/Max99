export { Card, Rank, Suit } from "../common/card";
import { Card, Rank } from "../common/card";

export function newShuffledDeck(): Card[] {
  return Card.newShuffledDeck();
}

export function cardStr(c: Card): string {
  return c.toEmoticonHotkey();
}

export class Hand {
  private cards: Card[] = [];

  add(card: Card): void { this.cards.push(card); }

  clear(): void { this.cards = []; }

  get size(): number { return this.cards.length; }

  at(index: number): Card { return this.cards[index]; }

  /**
   * Returns possible counts, highest first.
   * If Ace can count as 11 without busting, returns [high, low].
   * Otherwise returns [value]. Matches Java Hand.count() exactly.
   */
  count(): number[] {
    let minSum  = 0;
    let hasAce  = false;
    for (const c of this.cards) {
      switch (c.rank()) {
        case Rank.ACE:                                          minSum += 1; hasAce = true; break;
        case Rank.DEUCE:                                        minSum += 2; break;
        case Rank.THREE:                                        minSum += 3; break;
        case Rank.FOUR:                                         minSum += 4; break;
        case Rank.FIVE:                                         minSum += 5; break;
        case Rank.SIX:                                          minSum += 6; break;
        case Rank.SEVEN:                                        minSum += 7; break;
        case Rank.EIGHT:                                        minSum += 8; break;
        case Rank.NINE:                                         minSum += 9; break;
        case Rank.TEN: case Rank.JACK: case Rank.QUEEN: case Rank.KING: minSum += 10; break;
      }
    }
    const possibleCounts: number[] = [minSum];
    if (hasAce && minSum + 10 <= 21) {
      possibleCounts.unshift(minSum + 10);
    }
    return possibleCounts;
  }

  /** Best possible count (highest ≤ 21, or lowest if all bust). */
  highestCount(): number {
    return this.count()[0];
  }

  toString(): string {
    return this.cards.map(c => c.toEmoticonHotkey()).join(" ");
  }
}
