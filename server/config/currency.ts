/**
 * Currency configuration — single source of truth untuk semua rate konversi.
 *
 * Model ekonomi:
 *   User bayar  100.000 IDR → dapat 150.000 Coin (×1.5)
 *   Gift Coin   → 100% jadi Diamond ke host (÷10)
 *   Host WD     Diamond → IDR (×2)
 *
 * Verifikasi profit app:
 *   100.000 IDR masuk
 *   150.000 Coin ÷ 10 × 2 = 30.000 IDR keluar ke host
 *   Profit app = 70.000 IDR = 70% ✓
 *
 * Ubah rate di sini saja — semua kalkulasi di gateway & routes ikut otomatis.
 */

export const RATES = {
  IDR_TO_COIN:             1.5,   // 100.000 IDR = 150.000 Coin
  COIN_TO_DIAMOND:         10,    // 10 Coin = 1 Diamond  (normal)
  COIN_TO_DIAMOND_LUXURY:  6.67,  // 10 Coin = 1.5 Diamond (Luxury category bonus — 1.5×)
  DIAMOND_TO_IDR:          2,     // 1 Diamond = 2 IDR saat withdraw
  MIN_WD_DIAMOND:          25000, // minimum withdraw = 25.000 Diamond = 50.000 IDR
  APP_SHARE:               1.0,   // 100% coin gifts masuk, 70% profit sudah encoded di rates
} as const;

export type Rates = typeof RATES;

export const idrToCoin     = (idr: number): number => Math.floor(idr * RATES.IDR_TO_COIN);
export const coinToIdr     = (coin: number): number => Math.floor(coin / RATES.IDR_TO_COIN);
export const coinToDiamond = (coin: number): number => Math.floor(coin / RATES.COIN_TO_DIAMOND);
// Luxury: 10 Coin = 1.5 Diamond (1.5× normal rate)
export const luxuryCoinToDiamond = (coin: number): number => Math.floor(coin * 15 / 100);
export const diamondToIdr  = (diamond: number): number => Math.floor(diamond * RATES.DIAMOND_TO_IDR);
export const idrToDiamond  = (idr: number): number => coinToDiamond(idrToCoin(idr));

export function formatDiamond(amount: number): string {
  return `💎 ${Math.round(amount).toLocaleString('id-ID')}`;
}

export function formatCoin(amount: number): string {
  return `🪙 ${Math.round(amount).toLocaleString('id-ID')}`;
}
