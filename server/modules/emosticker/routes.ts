import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertEmoticonPackSchema, insertEmoticonSchema } from "@shared/schema";

// Mirrors EmoAndStickerDAO.java:
//   loadEmoticonPacks()       — SELECT ep.* FROM emoticonpack ep WHERE ep.status = ?
//   loadEmoticons()           — SELECT e.* FROM emoticon e
//   loadEmoticonHeights()     — SELECT DISTINCT height FROM emoticon ORDER BY height
//   getEmoticonPack(packId)   — packs filtered by packId
//   getOptimalEmoticonHeight  — closest height <= fontHeight

export function registerEmoStickerRoutes(app: Express): void {

  // GET /api/emosticker/packs — loadEmoticonPacks() (active only)
  app.get("/api/emosticker/packs", async (_req: Request, res: Response) => {
    const packs = await storage.getEmoticonPacks(true);
    return res.status(200).json({ packs });
  });

  // GET /api/emosticker/packs/all — all packs including inactive (admin)
  app.get("/api/emosticker/packs/all", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const packs = await storage.getEmoticonPacks(false);
    return res.status(200).json({ packs });
  });

  // GET /api/emosticker/packs/:id — getEmoticonPack(packId)
  app.get("/api/emosticker/packs/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid pack ID" });
    const pack = await storage.getEmoticonPack(id);
    if (!pack) return res.status(404).json({ message: "Emoticon pack not found" });
    const emoticons = await storage.getEmoticons(id);
    return res.status(200).json({ pack, emoticons });
  });

  // GET /api/emosticker/emoticons — loadEmoticons() all
  app.get("/api/emosticker/emoticons", async (req: Request, res: Response) => {
    const packId = req.query.packId ? parseInt(req.query.packId as string, 10) : undefined;
    const emoticons = await storage.getEmoticons(packId);
    return res.status(200).json({ emoticons });
  });

  // GET /api/emosticker/heights — loadEmoticonHeights()
  // Mirrors: SELECT DISTINCT height FROM emoticon ORDER BY height
  app.get("/api/emosticker/heights", async (_req: Request, res: Response) => {
    const heights = await storage.getEmoticonHeights();
    return res.status(200).json({ heights });
  });

  // GET /api/emosticker/optimal-height — getOptimalEmoticonHeight(fontHeight)
  // Mirrors EmoAndStickerDAO.getOptimalEmoticonHeight
  app.get("/api/emosticker/optimal-height", async (req: Request, res: Response) => {
    const fontHeight = parseInt(req.query.fontHeight as string, 10);
    if (isNaN(fontHeight) || fontHeight <= 0) return res.status(400).json({ message: "fontHeight harus berupa angka positif" });
    const height = await storage.getOptimalEmoticonHeight(fontHeight);
    return res.status(200).json({ optimalHeight: height });
  });

  // POST /api/emosticker/packs — createEmoticonPack (admin)
  app.post("/api/emosticker/packs", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const parsed = insertEmoticonPackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    const pack = await storage.createEmoticonPack(parsed.data);
    return res.status(201).json({ pack });
  });

  // PATCH /api/emosticker/packs/:id — updateEmoticonPack (admin)
  app.patch("/api/emosticker/packs/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid pack ID" });
    const pack = await storage.updateEmoticonPack(id, req.body);
    if (!pack) return res.status(404).json({ message: "Emoticon pack not found" });
    return res.status(200).json({ pack });
  });

  // POST /api/emosticker/emoticons — createEmoticon (admin)
  app.post("/api/emosticker/emoticons", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const parsed = insertEmoticonSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    const emo = await storage.createEmoticon(parsed.data);
    return res.status(201).json({ emoticon: emo });
  });

  // PATCH /api/emosticker/emoticons/:id — updateEmoticon (admin)
  app.patch("/api/emosticker/emoticons/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid emoticon ID" });
    const emo = await storage.updateEmoticon(id, req.body);
    if (!emo) return res.status(404).json({ message: "Emoticon not found" });
    return res.status(200).json({ emoticon: emo });
  });

  // DELETE /api/emosticker/emoticons/:id — deleteEmoticon (admin)
  app.delete("/api/emosticker/emoticons/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid emoticon ID" });
    await storage.deleteEmoticon(id);
    return res.status(200).json({ message: "Emoticon deleted" });
  });
}
