/**
 * botDAO.ts
 *
 * TypeScript port of:
 *  - com.projectgoth.fusion.dao.BotDAO (interface)
 *  - com.projectgoth.fusion.dao.impl.BotDAOJDBC (JDBC implementation)
 *
 * Loads bot definitions and per-bot config (key/value parameters) from the
 * `bots` and `bot_configs` tables, mirroring BotDAO.getBots() and
 * BotDAO.getBotConfig(botId).
 *
 * getBotMessages() and getBotCommands() are stubs — the old schema stored
 * these in separate `botmessages` / `botcommands` tables that are not yet
 * ported to the new schema. They return empty maps until those tables exist.
 */

import { storage } from "../../storage";
import type { Bot, BotConfig } from "../../../shared/schema";

export interface IBotDAO {
  getBots(): Promise<Bot[]>;
  getBotConfig(botId: number): Promise<Map<string, string>>;
  getBotMessages(botId: number, languageCode: string): Promise<Map<string, string>>;
  getBotCommands(botId: number, languageCode: string): Promise<Map<string, string>>;
}

class BotDAOImpl implements IBotDAO {
  /**
   * Return all active bots from the `bots` table.
   * Mirrors: BotDAOJDBC.getBots() → BotDAO.getBots.sql
   */
  async getBots(): Promise<Bot[]> {
    return storage.getBots(true);
  }

  /**
   * Load key/value config pairs for a specific bot.
   * Mirrors: BotDAOJDBC.getBotConfig(botID) → BotDAO.getBotConfig.sql
   *   SELECT PropertyName, PropertyValue FROM BotConfig WHERE BotID = ?
   */
  async getBotConfig(botId: number): Promise<Map<string, string>> {
    const configs: BotConfig[] = await storage.getBotConfigs(botId);
    const map = new Map<string, string>();
    for (const c of configs) {
      if (c.propertyName != null && c.propertyValue != null) {
        map.set(c.propertyName, c.propertyValue);
      }
    }
    return map;
  }

  /**
   * Load language-specific bot messages.
   * Mirrors: BotDAOJDBC.getBotMessages(botID, languageCode)
   * Returns empty map until a `bot_messages` table is added to the schema.
   */
  async getBotMessages(_botId: number, _languageCode: string): Promise<Map<string, string>> {
    return new Map();
  }

  /**
   * Load language-specific bot commands.
   * Mirrors: BotDAOJDBC.getBotCommands(botID, languageCode)
   * Returns empty map until a `bot_commands` table is added to the schema.
   */
  async getBotCommands(_botId: number, _languageCode: string): Promise<Map<string, string>> {
    return new Map();
  }
}

export const botDAO: IBotDAO = new BotDAOImpl();

/**
 * Resolve a bot's DB record by its game type string.
 * Used by BotLoader to find the matching `bots` row when starting a game.
 */
export async function getBotByGameType(gameType: string): Promise<Bot | undefined> {
  const all = await botDAO.getBots().catch(() => [] as Bot[]);
  return all.find(b => b.game.toLowerCase() === gameType.toLowerCase());
}

/**
 * Load config params for a bot game type from the database.
 * Returns an empty Record<string,string> if no DB record is found.
 * Mirrors: Bot.loadConfig() → botDAO.getBotConfig(botData.getId())
 */
export async function loadBotParams(gameType: string): Promise<Record<string, string>> {
  const bot = await getBotByGameType(gameType).catch(() => undefined);
  if (!bot) return {};
  const map = await botDAO.getBotConfig(bot.id).catch(() => new Map<string, string>());
  return Object.fromEntries(map.entries());
}
