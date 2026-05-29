/**
 * pot.ts
 *
 * TypeScript port of com.projectgoth.fusion.botservice.bot.Pot
 *
 * Manages the in-game stake pool (pot) for bot games.
 * In the Java version, stakes are persisted via AccountEJB.enterUserIntoPot /
 * payoutPotAndNotify / cancelPot. Here we keep stakes in-memory and call
 * storage.adjustBalance for the actual credit movements, matching the
 * chargeUser / refundUser helpers already on BotBase.
 *
 * Usage in a game bot:
 *   const pot = new Pot();
 *   await pot.enterPlayer(username, entryCost, chargeUserFn);
 *   ...
 *   const payout = await pot.payoutToWinner(winner, creditUserFn);
 *   // or
 *   await pot.cancel(refundUserFn);
 */

import { GameSpenderData, GameWinnerData, PayoutData } from "./payoutData";

export interface PotStake {
  username: string;
  amount:   number;
  eligible: boolean;
}

export class Pot {
  private stakes = new Map<string, PotStake>();

  get size(): number {
    return [...this.stakes.values()].filter(s => s.eligible).length;
  }

  /**
   * Add a player to the pot, charging their balance.
   * Mirrors: Pot.enterPlayer(username, amount, currency)
   */
  async enterPlayer(
    username: string,
    amount:   number,
    chargeFn: (username: string, amount: number) => Promise<void>,
  ): Promise<void> {
    if (this.stakes.has(username)) return;
    await chargeFn(username, amount);
    this.stakes.set(username, { username, amount, eligible: true });
  }

  /**
   * Remove a player from the pot (mark ineligible, no refund here).
   * Mirrors: Pot.removePlayer(username)
   */
  removePlayer(username: string): void {
    const stake = this.stakes.get(username);
    if (stake) stake.eligible = false;
  }

  hasPlayer(username: string): boolean {
    return (this.stakes.get(username)?.eligible) ?? false;
  }

  getEligiblePlayers(): string[] {
    return [...this.stakes.values()]
      .filter(s => s.eligible)
      .map(s => s.username);
  }

  getStake(username: string): PotStake | undefined {
    return this.stakes.get(username);
  }

  /**
   * Total credits currently in the pot (eligible players only).
   * Mirrors: Pot.getTotalAmountInBaseCurrency()
   */
  getTotalAmount(): number {
    let total = 0;
    for (const s of this.stakes.values()) {
      if (s.eligible) total += s.amount;
    }
    return total;
  }

  /**
   * Payout the entire pot to a single winner.
   * Mirrors: Pot.payout(username, cancelOnException)
   *
   * @returns PayoutData describing winners and spenders
   */
  async payoutToWinner(
    winnerUsername: string,
    creditFn: (username: string, amount: number) => Promise<void>,
    rakePercent = 0,
  ): Promise<PayoutData> {
    const total     = this.getTotalAmount();
    const winAmount = total * (1 - rakePercent / 100);

    await creditFn(winnerUsername, winAmount);

    const data = new PayoutData();
    data.totalPayoutPerUser = winAmount;
    data.addWinner(new GameWinnerData(winnerUsername, winAmount));
    for (const s of this.stakes.values()) {
      data.addSpender(new GameSpenderData(s.username, s.amount));
    }
    this.stakes.clear();
    return data;
  }

  /**
   * Payout the pot equally to multiple winners.
   * Mirrors: Pot.payout() (all eligible players split)
   */
  async payoutToWinners(
    winnerUsernames: string[],
    creditFn: (username: string, amount: number) => Promise<void>,
    rakePercent = 0,
  ): Promise<PayoutData> {
    const total      = this.getTotalAmount();
    const afterRake  = total * (1 - rakePercent / 100);
    const perWinner  = winnerUsernames.length > 0 ? afterRake / winnerUsernames.length : 0;

    for (const w of winnerUsernames) {
      await creditFn(w, perWinner);
    }

    const data = new PayoutData();
    data.totalPayoutPerUser = perWinner;
    for (const w of winnerUsernames) {
      data.addWinner(new GameWinnerData(w, perWinner));
    }
    for (const s of this.stakes.values()) {
      data.addSpender(new GameSpenderData(s.username, s.amount));
    }
    this.stakes.clear();
    return data;
  }

  /**
   * Cancel the pot — refund all eligible players.
   * Mirrors: Pot.cancel()
   */
  async cancel(
    refundFn: (username: string, amount: number) => Promise<void>,
  ): Promise<void> {
    for (const s of this.stakes.values()) {
      if (s.eligible) {
        await refundFn(s.username, s.amount).catch(() => {});
      }
    }
    this.stakes.clear();
  }

  /** Expose spenders for logging / leaderboard. */
  getSpenders(): GameSpenderData[] {
    return [...this.stakes.values()].map(s => new GameSpenderData(s.username, s.amount));
  }

  toString(): string {
    const lines = [`Pot total: ${this.getTotalAmount()} credits`];
    for (const s of this.stakes.values()) {
      lines.push(`  ${s.username}: ${s.amount} (eligible=${s.eligible})`);
    }
    return lines.join("\n");
  }
}
