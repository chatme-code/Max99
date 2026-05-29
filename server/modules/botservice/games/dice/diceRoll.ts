import { Die } from "../common/die";

export class DiceRoll {
  private die1 = new Die();
  private die2 = new Die();
  private _isWinner = false;

  roll(): void {
    this.die1.roll();
    this.die2.roll();
  }

  rollAndMatch(targetTotal: number): void {
    this.roll();
    this._isWinner = this.total() >= targetTotal;
  }

  getDie1(): number { return this.die1.getValue(); }
  getDie2(): number { return this.die2.getValue(); }

  total(): number { return this.die1.getValue() + this.die2.getValue(); }

  reset(): void {
    this.die1 = new Die();
    this.die2 = new Die();
    this._isWinner = false;
  }

  isWinner(): boolean { return this._isWinner; }

  toString(): string {
    return this.die1.toEmoticonHotkey() + " " + this.die2.toEmoticonHotkey();
  }
}
