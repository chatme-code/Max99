import { gameRegistry, GameDescriptor } from "./GameRegistry";
import type { BotBase } from "./botBase";
import { BotCommandEnum } from "../campaign/message/NotificationMessage";

/**
 * BotChannelHelper.ts
 *
 * Helper untuk operasi channel-level pada bot game.
 * Mirrors: com.projectgoth.fusion.botservice.BotChannelHelper (Java)
 *
 * - updateBots()  → kirim notifikasi JOIN/QUIT ke semua bot aktif di channel
 * - getGames()    → kembalikan daftar game yang tersedia dari GameRegistry
 */

/**
 * Kirim notifikasi JOIN atau QUIT ke semua bot yang aktif di sebuah channel/room.
 * Mirrors: BotChannelHelper.updateBots(username, command, channelBots, channelID)
 */
export function updateBots(
  username: string,
  command: BotCommandEnum,
  channelBots: Map<string, BotBase>,
): void {
  for (const [instanceId, bot] of channelBots) {
    try {
      if (command === BotCommandEnum.JOIN) {
        bot.onUserJoinChannel(username);
      } else if (command === BotCommandEnum.QUIT) {
        bot.onUserLeaveChannel(username);
      }
    } catch (e) {
      console.error(
        `[BotChannelHelper] Gagal update bot instanceId="${instanceId}" ` +
        `untuk user="${username}" command=${command}: ${(e as Error).message}`,
      );
    }
  }
}

/**
 * Kembalikan daftar tipe game yang tersedia dari GameRegistry.
 * Mirrors: BotChannelHelper.getGames() → messageEJB.getBots()
 */
export function getGames(): string[] {
  return gameRegistry.getNames();
}

/**
 * Kembalikan deskriptor lengkap semua game yang terdaftar.
 */
export function getGameDescriptors(): GameDescriptor[] {
  return gameRegistry.list();
}
