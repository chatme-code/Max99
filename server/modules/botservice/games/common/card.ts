export const EMOTICONS: string[] = [
  "(2C)","(3C)","(4C)","(5C)","(6C)","(7C)","(8C)","(9C)","(TC)","(JC)","(QC)","(KC)","(AC)",
  "(2D)","(3D)","(4D)","(5D)","(6D)","(7D)","(8D)","(9D)","(TD)","(JD)","(QD)","(KD)","(AD)",
  "(2H)","(3H)","(4H)","(5H)","(6H)","(7H)","(8H)","(9H)","(TH)","(JH)","(QH)","(KH)","(AH)",
  "(2S)","(3S)","(4S)","(5S)","(6S)","(7S)","(8S)","(9S)","(TS)","(JS)","(QS)","(KS)","(AS)",
];

export enum Suit {
  CLUBS    = "C",
  DIAMONDS = "D",
  HEARTS   = "H",
  SPADES   = "S",
}

export namespace Suit {
  export function toChar(s: Suit): string { return s as string; }
  export function fromChar(c: string): Suit | null {
    for (const s of Object.values(Suit) as Suit[]) {
      if (s === c) return s;
    }
    return null;
  }
}

export enum Rank {
  DEUCE = "2",
  THREE = "3",
  FOUR  = "4",
  FIVE  = "5",
  SIX   = "6",
  SEVEN = "7",
  EIGHT = "8",
  NINE  = "9",
  TEN   = "T",
  JACK  = "J",
  QUEEN = "Q",
  KING  = "K",
  ACE   = "A",
}

const RANK_ORDER: Record<Rank, number> = {
  [Rank.DEUCE]:  1,
  [Rank.THREE]:  2,
  [Rank.FOUR]:   3,
  [Rank.FIVE]:   4,
  [Rank.SIX]:    5,
  [Rank.SEVEN]:  6,
  [Rank.EIGHT]:  7,
  [Rank.NINE]:   8,
  [Rank.TEN]:    9,
  [Rank.JACK]:  10,
  [Rank.QUEEN]: 11,
  [Rank.KING]:  12,
  [Rank.ACE]:   13,
};

export namespace Rank {
  export function getRankOrder(r: Rank): number { return RANK_ORDER[r]; }
  export function toChar(r: Rank): string { return r as string; }
  export function fromChar(c: string): Rank | null {
    for (const r of Object.values(Rank) as Rank[]) {
      if (r === c) return r;
    }
    return null;
  }
}

const RANKS: Rank[] = [
  Rank.DEUCE, Rank.THREE, Rank.FOUR, Rank.FIVE, Rank.SIX,
  Rank.SEVEN, Rank.EIGHT, Rank.NINE, Rank.TEN,
  Rank.JACK,  Rank.QUEEN, Rank.KING, Rank.ACE,
];

const SUITS: Suit[] = [Suit.CLUBS, Suit.DIAMONDS, Suit.HEARTS, Suit.SPADES];

const BASE_DECK: Card[] = [];

export class Card {
  constructor(
    private readonly _rank: Rank,
    private readonly _suit: Suit,
  ) {}

  rank(): Rank { return this._rank; }
  suit(): Suit { return this._suit; }

  toString(): string {
    return Rank.toChar(this._rank) + Suit.toChar(this._suit);
  }

  toEmoticonHotkey(): string {
    return "(" + this.toString() + ")";
  }

  toLowcardImagePath(): string {
    const rank = Rank.toChar(this._rank).toLowerCase();
    const suit = Suit.toChar(this._suit).toLowerCase();
    return `migme/assets/card/lowcard/lowcard/lc_${rank}${suit}.png`;
  }

  compareTo(other: Card): number {
    const thisOrder  = Rank.getRankOrder(this._rank);
    const otherOrder = Rank.getRankOrder(other._rank);
    if (otherOrder < thisOrder) return  1;
    if (otherOrder > thisOrder) return -1;
    return 0;
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Card)) return false;
    return Rank.getRankOrder(this._rank) === Rank.getRankOrder(other._rank);
  }

  static newShuffledDeck(): Card[] {
    const deck = [...BASE_DECK];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }
}

(function buildDeck() {
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      BASE_DECK.push(new Card(rank, suit));
    }
  }
})();
