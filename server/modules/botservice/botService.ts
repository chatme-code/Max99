import { BotBase } from "./botBase";
import { addBotToChannel } from "./BotLoader";

/**
 * botService.ts
 *
 * Inti dari BotService — mengelola siklus hidup bot game per room.
 * Mirrors: com.projectgoth.fusion.botservice.BotServiceI (Java)
 *
 * Tambahan vs Java:
 *  - getBotServiceStats()   → setara BotServiceAdminI.getStats()
 *  - channelBotMappings     → Map<roomId, Map<instanceId, BotBase>>
 *  - requestCounter         → hitung request per detik
 */

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface BotServiceStats {
  numBotObjects:        number;
  numBotChannelObjects: number;
  requestsTotal:        number;
  requestsPerSecond:    number;
  uptimeMs:             number;
  startTime:            number;
}

const startTime = Date.now();
let requestsTotal = 0;
let requestsInWindow = 0;
let requestsPerSecond = 0;

setInterval(() => {
  requestsPerSecond  = requestsInWindow;
  requestsInWindow   = 0;
}, 1_000);

function countRequest(): void {
  requestsTotal++;
  requestsInWindow++;
}

export function getBotServiceStats(): BotServiceStats {
  return {
    numBotObjects:        activeBots.size,
    numBotChannelObjects: channelBotMappings.size,
    requestsTotal,
    requestsPerSecond,
    uptimeMs:             Date.now() - startTime,
    startTime,
  };
}

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * activeBots: roomId → BotBase (satu bot aktif per room)
 * Mirrors: BotServiceI.botMappings (Map<String, Bot>)
 */
const activeBots = new Map<string, BotBase>();

/**
 * channelBotMappings: roomId → Map<instanceId, BotBase>
 * Tracks semua bot (termasuk bot yang mungkin overlap sebelum purge).
 * Mirrors: BotServiceI.channelBotMappings (Map<String, Set<Bot>>)
 */
const channelBotMappings = new Map<string, Map<string, BotBase>>();

// ─── Internal helpers ─────────────────────────────────────────────────────────

function registerToChannel(roomId: string, bot: BotBase): void {
  if (!channelBotMappings.has(roomId)) {
    channelBotMappings.set(roomId, new Map());
  }
  channelBotMappings.get(roomId)!.set(bot.instanceId, bot);
}

function unregisterFromChannel(roomId: string, bot: BotBase): void {
  const bots = channelBotMappings.get(roomId);
  if (!bots) return;
  bots.delete(bot.instanceId);
  if (bots.size === 0) channelBotMappings.delete(roomId);
}

function pruneIdleBots(): void {
  for (const [roomId, bot] of activeBots) {
    if (bot.isIdle()) {
      bot.stopBot();
      unregisterFromChannel(roomId, bot);
      activeBots.delete(roomId);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start bot baru di room.
 * Mirrors: BotServiceI.addBotToChannel()
 *
 * Async karena addBotToChannel sekarang memuat params dari DB (BotDAO).
 */
export async function startBot(roomId: string, gameType: string, starterUsername: string): Promise<BotBase> {
  countRequest();
  const existing = activeBots.get(roomId);
  if (existing) {
    if (!existing.canBeStoppedNow()) {
      throw new Error("A game is currently in progress in this room");
    }
    existing.stopBot();
    unregisterFromChannel(roomId, existing);
  }
  const bot = await addBotToChannel(gameType, { roomId, starterUsername, params: {} });
  activeBots.set(roomId, bot);
  registerToChannel(roomId, bot);
  return bot;
}

/**
 * Stop bot di room.
 * Mirrors: BotServiceI.killBot()
 */
export function stopBot(roomId: string): boolean {
  countRequest();
  const bot = activeBots.get(roomId);
  if (!bot) return false;
  bot.stopBot();
  unregisterFromChannel(roomId, bot);
  activeBots.delete(roomId);
  return true;
}

/**
 * Ambil bot aktif di room.
 */
export function getBot(roomId: string): BotBase | undefined {
  return activeBots.get(roomId);
}

/**
 * List semua bot aktif.
 * Mirrors: BotServiceI.getStats() partial
 */
export function listActiveBots(): { roomId: string; gameType: string; instanceId: string }[] {
  return [...activeBots.entries()].map(([roomId, bot]) => ({
    roomId,
    gameType:   bot.gameType,
    instanceId: bot.instanceId,
  }));
}

/**
 * Kembalikan semua bot di channel (untuk BotChannelHelper.updateBots).
 */
export function getChannelBots(roomId: string): Map<string, BotBase> {
  return channelBotMappings.get(roomId) ?? new Map();
}

/**
 * Proses pesan dari user — teruskan ke bot jika ada.
 * Mirrors: BotServiceI dispatch flow
 */
export function processMessage(roomId: string, username: string, text: string): boolean {
  countRequest();
  const bot = activeBots.get(roomId);
  if (!bot) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return false;
  try {
    const result = bot.onMessage(username, trimmed, Date.now());
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.error(`[BotService] Error in ${bot.gameType}.onMessage:`, err);
      });
    }
  } catch (err) {
    console.error(`[BotService] Sync error in ${bot.gameType}.onMessage:`, err);
  }
  return true;
}

/**
 * Notifikasi user JOIN ke bot aktif di room.
 * Mirrors: BotServiceI.sendNotificationToBotsInChannel (JOIN)
 */
export function notifyUserJoin(roomId: string, username: string): void {
  activeBots.get(roomId)?.onUserJoinChannel(username);
}

/**
 * Notifikasi user LEAVE ke bot aktif di room.
 * Mirrors: BotServiceI.sendNotificationToBotsInChannel (QUIT)
 */
export function notifyUserLeave(roomId: string, username: string): void {
  activeBots.get(roomId)?.onUserLeaveChannel(username);
}

/**
 * Purge semua bot yang idle — bisa dipanggil manual dari admin panel.
 * Auto-purge periodik sengaja dinonaktifkan agar bot tidak berhenti sendiri;
 * bot hanya berhenti lewat /bot stop atau restart server.
 * Mirrors: BotService.IdleBotPurger (Java inner class)
 */
export function purgeIdleBots(): void {
  pruneIdleBots();
}
