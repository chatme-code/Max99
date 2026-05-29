import { getBotServiceStats, BotServiceStats } from "./botService";

/**
 * BotServiceAdminI.ts
 *
 * Admin interface untuk monitoring dan health check BotService.
 * Di Java, ini adalah Ice servant yang di-expose ke admin adapter.
 * Di TypeScript/Express, fungsi-fungsinya di-expose via REST endpoints.
 *
 * Mirrors: com.projectgoth.fusion.botservice.BotServiceAdminI (Java)
 */
export class BotServiceAdminI {

  /**
   * Kembalikan statistik lengkap BotService.
   * Mirrors: BotServiceAdminI.getStats(Current current)
   */
  getStats(): BotServiceStats {
    return getBotServiceStats();
  }

  /**
   * Health check — kembalikan jumlah bot yang aktif saat ini.
   * Mirrors: BotServiceAdminI.ping(Current current) → numBotObjects
   */
  ping(): number {
    return getBotServiceStats().numBotObjects;
  }
}

export const botServiceAdmin = new BotServiceAdminI();
