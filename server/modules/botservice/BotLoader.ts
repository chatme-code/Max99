import type { BotContext } from "./botBase";
import type { BotBase } from "./botBase";
import { loadBotParams } from "./botDAO";
import { gameRegistry } from "./GameRegistry";

// Import semua game — side-effect: tiap game mendaftarkan dirinya ke gameRegistry
import "./games/index";

/**
 * BotLoader.ts
 *
 * Factory yang membuat instance bot game berdasarkan gameType.
 * Kini menggunakan GameRegistry (self-registration pattern) — tidak ada
 * import eksplisit per game di sini. Untuk menambah game baru, cukup:
 *   1. Buat class game + panggil gameRegistry.register() di akhir file
 *   2. Import file tersebut di games/index.ts
 *
 * Mirrors: com.projectgoth.fusion.botservice.BotLoader (Java)
 */

/**
 * Buat instance bot untuk channel tertentu.
 * Mirrors: BotLoader.addBotToChannel(executor, botData, channelProxy, botDAO, starter, lang)
 */
export async function addBotToChannel(gameType: string, ctx: BotContext): Promise<BotBase> {
  const descriptor = gameRegistry.get(gameType);
  if (!descriptor) {
    const available = gameRegistry.getNames().join(", ");
    throw new Error(`[BotLoader] Unknown gameType: "${gameType}". Available: ${available}`);
  }

  // Load params dari DB (mirrors Bot.loadConfig → botDAO.getBotConfig)
  // DB values adalah base; ctx.params (caller overrides) mengambil prioritas.
  const dbParams = await loadBotParams(gameType).catch(() => ({}));
  const mergedParams = { ...dbParams, ...ctx.params };

  return descriptor.factory({ ...ctx, params: mergedParams });
}

/**
 * Cek apakah gameType terdaftar di registry.
 */
export function isRegisteredGame(gameType: string): boolean {
  return gameRegistry.has(gameType);
}

/**
 * Kembalikan semua gameType yang terdaftar.
 */
export function getRegisteredGames(): string[] {
  return gameRegistry.getNames();
}
