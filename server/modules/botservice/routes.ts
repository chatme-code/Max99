import type { Express, Request, Response } from "express";
import { startBot, stopBot, getBot, listActiveBots } from "./botService";
import { botServiceAdmin } from "./BotServiceAdminI";
import { getGames, getGameDescriptors } from "./BotChannelHelper";
import { isRegisteredGame } from "./BotLoader";
import { storage } from "../../storage";

export function registerBotServiceRoutes(app: Express): void {

  // GET /api/botservice/games — daftar game yang terdaftar (nama saja)
  app.get("/api/botservice/games", (_req: Request, res: Response) => {
    res.json({ games: getGames() });
  });

  // GET /api/botservice/games/info — daftar game dengan metadata lengkap
  app.get("/api/botservice/games/info", (_req: Request, res: Response) => {
    const descriptors = getGameDescriptors().map(({ factory: _f, ...rest }) => rest);
    res.json({ games: descriptors });
  });

  app.get("/api/botservice/active", (_req: Request, res: Response) => {
    res.json({ bots: listActiveBots() });
  });

  app.get("/api/botservice/rooms/:roomId", (req: Request, res: Response) => {
    const bot = getBot(req.params.roomId);
    if (!bot) return res.status(404).json({ message: "No active bot in this room" });
    return res.json({ roomId: req.params.roomId, gameType: bot.gameType, instanceId: bot.instanceId });
  });

  app.post("/api/botservice/rooms/:roomId/start", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const { gameType } = req.body as { gameType?: string };
    if (!gameType || !isRegisteredGame(gameType)) {
      return res.status(400).json({ message: `Invalid gameType. Valid: ${getGames().join(", ")}` });
    }
    try {
      const sessionUser = await storage.getUser(req.session.userId as string);
      if (!sessionUser) return res.status(401).json({ message: "Pengguna tidak ditemukan." });
      const username: string = sessionUser.username;
      const bot = await startBot(req.params.roomId, gameType, username);
      return res.status(201).json({
        message: "Bot started",
        roomId:     req.params.roomId,
        gameType:   bot.gameType,
        instanceId: bot.instanceId,
      });
    } catch (err: any) {
      return res.status(409).json({ message: err.message ?? "Could not start bot" });
    }
  });

  app.delete("/api/botservice/rooms/:roomId", (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const stopped = stopBot(req.params.roomId);
    if (!stopped) return res.status(404).json({ message: "No active bot in this room" });
    return res.json({ message: "Bot stopped" });
  });

  // ── Admin endpoints ─────────────────────────────────────────────────────────

  app.get("/api/botservice/admin/stats", (_req: Request, res: Response) => {
    return res.json({ stats: botServiceAdmin.getStats() });
  });

  app.get("/api/botservice/admin/ping", (_req: Request, res: Response) => {
    return res.json({ numBotObjects: botServiceAdmin.ping() });
  });

  app.get("/api/botservice/admin/games", (_req: Request, res: Response) => {
    return res.json({ games: getGames() });
  });
}
