/**
 * payoutData.ts
 *
 * TypeScript port of Java payout data classes:
 *  - com.projectgoth.fusion.data.pot.GameSpenderData
 *  - com.projectgoth.fusion.data.pot.GameWinnerData
 *  - com.projectgoth.fusion.data.pot.PayoutData
 */

export class GameSpenderData {
  constructor(
    readonly username:             string,
    readonly spendingAmount:       number,
    readonly spendingFundedAmount: number = spendingAmount,
    readonly currency:             string = "credits",
  ) {}

  toString(): string {
    return `GameSpenderData [username=${this.username}, amount=${this.spendingAmount}, funded=${this.spendingFundedAmount}, currency=${this.currency}]`;
  }
}

export class GameWinnerData {
  constructor(
    readonly username:             string,
    readonly winningAmount:        number,
    readonly fundedWinningAmount:  number = winningAmount,
    readonly currency:             string = "credits",
  ) {}

  toString(): string {
    return `GameWinnerData [username=${this.username}, winning=${this.winningAmount}, funded=${this.fundedWinningAmount}, currency=${this.currency}]`;
  }
}

export class PayoutData {
  private _winners:  GameWinnerData[]  = [];
  private _spenders: GameSpenderData[] = [];
  private _totalPayoutPerUser = 0;
  botId = 0;

  addWinner(data: GameWinnerData):  readonly GameWinnerData[]  { this._winners.push(data);  return this._winners; }
  addSpender(data: GameSpenderData): readonly GameSpenderData[] { this._spenders.push(data); return this._spenders; }

  get winners():  readonly GameWinnerData[]  { return this._winners; }
  get spenders(): readonly GameSpenderData[] { return this._spenders; }

  get totalPayoutPerUser(): number { return this._totalPayoutPerUser; }
  set totalPayoutPerUser(v: number) { this._totalPayoutPerUser = v; }

  toString(): string {
    return `PayoutData [totalPayoutPerUser=${this._totalPayoutPerUser}, botId=${this.botId}, winners=${this._winners.length}, spenders=${this._spenders.length}]`;
  }
}
