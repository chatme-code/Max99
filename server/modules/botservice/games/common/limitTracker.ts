export class LimitTracker {
  private expires:         number;
  private amountSpent:     Map<string, number> = new Map();
  private lastAmountSpent: Map<string, number> = new Map();

  constructor(instanceID: string, expires: number, amount: number) {
    this.expires = expires;
    this.amountSpent.set(instanceID, amount);
  }

  getExpires(): number { return this.expires; }

  getTotalAmountSpent(): number {
    let total = 0;
    for (const value of this.amountSpent.values()) {
      total += value;
    }
    return total;
  }

  add(instanceID: string, amount: number): void {
    const current = this.amountSpent.get(instanceID) ?? 0;
    this.lastAmountSpent.set(instanceID, amount);
    this.amountSpent.set(instanceID, current + amount);
  }

  revert(instanceID: string): number {
    if (!this.lastAmountSpent.has(instanceID)) {
      const value = this.amountSpent.get(instanceID) ?? 0;
      this.amountSpent.delete(instanceID);
      return value;
    }
    const revert = this.lastAmountSpent.get(instanceID)!;
    this.lastAmountSpent.delete(instanceID);
    const current = this.amountSpent.get(instanceID);
    if (current !== undefined) {
      this.amountSpent.set(instanceID, current - revert);
    }
    return revert;
  }

  hasExpired(currentTimeInMillis: number): boolean {
    return this.expires < currentTimeInMillis;
  }
}
