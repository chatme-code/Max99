// Currency helpers — IDR-only.
//
// The platform now uses a single currency (IDR) for every credit account.
// USD support has been removed: balances, transactions, payments, and gifts
// are all denominated in IDR. These helpers are kept as thin shims so older
// call sites that pass a `currency` argument keep working without conversion
// surprises (everything is normalized to IDR).

export const SUPPORTED_CURRENCY = "IDR" as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCY;

// Always returns IDR. Any non-IDR value is treated as IDR to avoid surprise
// conversions; we no longer maintain an exchange rate.
function normalizeCurrency(_currency: string | null | undefined): SupportedCurrency {
  return SUPPORTED_CURRENCY;
}

// No-op conversion: every balance is IDR, so we just round to whole rupiah.
export function convertCredits(amount: number, _from: string, _to: string): number {
  return Math.round(amount);
}

// Convenience: IDR amount stays as IDR.
export function idrToCurrency(amountIdr: number, _targetCurrency: string): number {
  return Math.round(amountIdr);
}

// Exposed for any caller that needs to coerce arbitrary input to IDR.
export function toSupportedCurrency(_currency: string | null | undefined): SupportedCurrency {
  return normalizeCurrency(_currency);
}
