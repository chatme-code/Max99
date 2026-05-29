export const BLUE   = 1;
export const GREEN  = 2;
export const RED    = 3;
export const YELLOW = 4;
export const WILD_COLOR = 10;

export const WILD        = 10;
export const DRAW_2      = 20;
export const REVERSE     = 21;
export const SKIP        = 22;
export const WILD_DRAW_4 = 23;
export const ANY         = 99;

export const STR_WILD        = "w";
export const STR_DRAW_2      = "d2";
export const STR_REVERSE     = "r";
export const STR_SKIP        = "s";
export const STR_WILD_DRAW_4 = "wd4";
export const STR_ANY         = "*";

export const COLOR_EMOTICONS: Record<number, string> = {
  [BLUE]:   "(uno_blue)",
  [GREEN]:  "(uno_green)",
  [RED]:    "(uno_red)",
  [YELLOW]: "(uno_yellow)",
};

export const COLOR_CHARS: Record<string, number> = {
  b: BLUE,
  g: GREEN,
  r: RED,
  y: YELLOW,
};

export class Card {
  private colour: number;
  private value:  number;

  constructor(colour: number, value: number) {
    this.colour = colour;
    this.value  = value;
  }

  getColour(): number { return this.colour; }
  getValue():  number { return this.value;  }

  toString(): string {
    let valueStr: string;
    switch (this.value) {
      case WILD:        valueStr = STR_WILD;        break;
      case WILD_DRAW_4: valueStr = STR_WILD_DRAW_4; break;
      case REVERSE:     valueStr = STR_REVERSE;     break;
      case DRAW_2:      valueStr = STR_DRAW_2;      break;
      case SKIP:        valueStr = STR_SKIP;        break;
      case ANY:         valueStr = STR_ANY;         break;
      default:          valueStr = String(this.value);
    }
    const colorStr = COLOR_EMOTICONS[this.colour] ?? "";
    return valueStr + colorStr;
  }

  equals(other: Card): boolean {
    return this.value === other.value && this.colour === other.colour;
  }

  compareTo(other: Card): number {
    if (this.value < other.getValue()) return -1;
    if (this.value > other.getValue()) return  1;
    return 0;
  }
}
