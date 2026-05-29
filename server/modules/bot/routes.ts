import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertBotSchema, insertBotConfigSchema } from "@shared/schema";

// Mirrors BotDAO.java: getBot(botID) — SELECT * FROM bot WHERE id = ? AND status = 1
// Mirrors FusionDbBotDAOChain.java: full CRUD via bots table

export function registerBotRoutes(app: Express): void {

  // GET /api/bots — list all active bots (mirrors getBots with status = 1)
  app.get("/api/bots", async (_req: Request, res: Response) => {
    const botList = await storage.getBots(true);
    return res.status(200).json({ bots: botList });
  });

  // GET /api/bots/all — list all bots including inactive (admin use)
  app.get("/api/bots/all", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const botList = await storage.getBots(false);
    return res.status(200).json({ bots: botList });
  });

  // GET /api/bots/:id — getBot(botID) — mirrors FusionDbBotDAOChain.getBot
  app.get("/api/bots/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
    const bot = await storage.getBot(id);
    if (!bot) return res.status(404).json({ message: "Bot not found" });
    return res.status(200).json({ bot });
  });

  // GET /api/bots/:id/configs — getBotConfigs(botId) — mirrors botconfig table
  app.get("/api/bots/:id/configs", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
    const bot = await storage.getBot(id);
    if (!bot) return res.status(404).json({ message: "Bot not found" });
    const configs = await storage.getBotConfigs(id);
    return res.status(200).json({ configs });
  });

  // POST /api/bots — createBot (admin)
  app.post("/api/bots", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const parsed = insertBotSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    const bot = await storage.createBot(parsed.data);
    return res.status(201).json({ bot });
  });

  // PATCH /api/bots/:id — updateBot (admin)
  app.patch("/api/bots/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
    const bot = await storage.updateBot(id, req.body);
    if (!bot) return res.status(404).json({ message: "Bot not found" });
    return res.status(200).json({ bot });
  });

  // DELETE /api/bots/:id — deleteBot (admin)
  app.delete("/api/bots/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid bot ID" });
    const bot = await storage.getBot(id);
    if (!bot) return res.status(404).json({ message: "Bot not found" });
    await storage.deleteBot(id);
    return res.status(200).json({ message: "Bot deleted" });
  });
}
