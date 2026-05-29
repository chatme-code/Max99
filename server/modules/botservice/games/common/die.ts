import { randomBytes } from "crypto";

export class Die {
  private _value = 1;

  getValue(): number { return this._value; }

  toEmoticonHotkey(): string {
    return "(d" + this._value.toString() + ")";
  }

  toDiceImagePath(): string {
    return `migme/assets/card/Dice/dice/d${this._value}.png`;
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Die)) return false;
    return this._value === other._value;
  }

  toString(): string { return this._value.toString(); }

  roll(): number {
    this._value = (randomBytes(1)[0] % 6) + 1;
    return this._value;
  }

  rollAndGetEmoticonHotkey(): string {
    this.roll();
    return this.toEmoticonHotkey();
  }
}
