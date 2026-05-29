export enum CricketCard {
  ONE          = "ONE",
  TWO          = "TWO",
  THREE        = "THREE",
  FOUR         = "FOUR",
  SIX          = "SIX",
  BOWLED       = "BOWLED",
  STUMPED      = "STUMPED",
  CATCH        = "CATCH",
  HIT_WICKET   = "HIT_WICKET",
  LBW          = "LBW",
  RUN_OUT      = "RUN_OUT",
  THIRD_UMPIRE = "THIRD_UMPIRE",
}

interface CardMeta {
  type:        string;
  name:        string;
  emoticonKey: string;
}

const CARD_META: Record<CricketCard, CardMeta> = {
  [CricketCard.ONE]:          { type: "1", name: "One",               emoticonKey: "(g-cr1)" },
  [CricketCard.TWO]:          { type: "2", name: "Two",               emoticonKey: "(g-cr2)" },
  [CricketCard.THREE]:        { type: "3", name: "Three",             emoticonKey: "(g-cr3)" },
  [CricketCard.FOUR]:         { type: "4", name: "Four",              emoticonKey: "(g-cr4)" },
  [CricketCard.SIX]:          { type: "6", name: "Six",               emoticonKey: "(g-cr6)" },
  [CricketCard.BOWLED]:       { type: "O", name: "Bowled",            emoticonKey: "(g-crBowled)" },
  [CricketCard.STUMPED]:      { type: "O", name: "Stumped",           emoticonKey: "(g-crStumped)" },
  [CricketCard.CATCH]:        { type: "O", name: "Catch",             emoticonKey: "(g-crCatch)" },
  [CricketCard.HIT_WICKET]:   { type: "O", name: "Hit Wicket",        emoticonKey: "(g-crHitWicket)" },
  [CricketCard.LBW]:          { type: "O", name: "Leg Before Wicket", emoticonKey: "(g-crLBW)" },
  [CricketCard.RUN_OUT]:      { type: "O", name: "Run Out",           emoticonKey: "(g-crRunOut)" },
  [CricketCard.THIRD_UMPIRE]: { type: "U", name: "Third Umpire",      emoticonKey: "(g-crThirdUmpire)" },
};

// Deck combination — matches Kotlin Deck.kt
const COMBINATION: [CricketCard, number][] = [
  [CricketCard.ONE,          45],
  [CricketCard.TWO,          39],
  [CricketCard.THREE,         3],
  [CricketCard.FOUR,         21],
  [CricketCard.SIX,          12],
  [CricketCard.BOWLED,        4],
  [CricketCard.STUMPED,       2],
  [CricketCard.CATCH,         6],
  [CricketCard.HIT_WICKET,    1],
  [CricketCard.LBW,           3],
  [CricketCard.RUN_OUT,       2],
  [CricketCard.THIRD_UMPIRE,  3],
];

export function getCardType(card: CricketCard): string        { return CARD_META[card].type; }
export function getCardName(card: CricketCard): string        { return CARD_META[card].name; }
export function getCardEmoticon(card: CricketCard): string    { return CARD_META[card].emoticonKey; }

export class Deck {
  private deck: CricketCard[] = [];

  init(): void {
    this.deck = [];
    for (const [card, qty] of COMBINATION) {
      for (let i = 0; i < qty; i++) {
        this.deck.push(card);
      }
    }
    this.shuffle();
  }

  shuffle(): void {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  draw(): CricketCard | null {
    if (this.deck.length <= 0) return null;
    return this.deck.shift()!;
  }
}
