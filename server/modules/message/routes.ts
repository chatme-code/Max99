import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertClientTextSchema, insertAlertMessageSchema, CLIENT_TEXT_TYPE } from "@shared/schema";

export function registerMessageRoutes(app: Express): void {

  // ── Client Texts (mirrors clienttext table) ───────────────────────────────

  // GET /api/messages/texts — getClientTexts (all)
  app.get("/api/messages/texts", async (req: Request, res: Response) => {
    const texts = await storage.getClientTexts();
    return res.status(200).json({ texts });
  });

  // GET /api/messages/texts/help — loadHelpTexts()
  // Java: FusionDbMessageDAOChain.loadHelpTexts
  // SQL:  SELECT * FROM clienttext WHERE type = 1
  // Returns: { helpTexts: Record<id, text> }
  app.get("/api/messages/texts/help", async (req: Request, res: Response) => {
    const helpTexts = await storage.loadHelpTexts();
    return res.status(200).json({ helpTexts });
  });

  // GET /api/messages/texts/info — loadInfoTexts()
  // Java: FusionDbMessageDAOChain.loadInfoTexts
  // SQL:  SELECT * FROM clienttext WHERE type = 2
  // Returns: { infoTexts: Record<id, text> }
  app.get("/api/messages/texts/info", async (req: Request, res: Response) => {
    const infoTexts = await storage.loadInfoTexts();
    return res.status(200).json({ infoTexts });
  });

  // GET /api/messages/texts/info/:id — getInfoText(infoId)
  // Java: FusionDbMessageDAOChain.getInfoText
  // SQL:  SELECT text FROM clienttext WHERE id = ? AND type = 2
  app.get("/api/messages/texts/info/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    const text = await storage.getInfoText(id);
    if (text === undefined) return res.status(404).json({ message: "Info text tidak ditemukan" });
    return res.status(200).json({ id, text });
  });

  // POST /api/messages/texts — createClientText (admin)
  app.post("/api/messages/texts", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const parsed = insertClientTextSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    const item = await storage.createClientText(parsed.data);
    return res.status(201).json({ text: item });
  });

  // PUT /api/messages/texts/:id — updateClientText (admin)
  app.put("/api/messages/texts/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    const updated = await storage.updateClientText(id, req.body);
    if (!updated) return res.status(404).json({ message: "Text tidak ditemukan" });
    return res.status(200).json({ text: updated });
  });

  // DELETE /api/messages/texts/:id — deleteClientText (admin)
  app.delete("/api/messages/texts/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    await storage.deleteClientText(id);
    return res.status(200).json({ message: "Text dihapus" });
  });

  // ── Alert Messages (mirrors alertmessage table) ───────────────────────────

  // GET /api/messages/alerts — getAlertMessages (admin, semua)
  app.get("/api/messages/alerts", async (req: Request, res: Response) => {
    const status = req.query.status !== undefined ? Number(req.query.status) : undefined;
    const alerts = await storage.getAlertMessages(status);
    return res.status(200).json({ alerts });
  });

  // GET /api/messages/alerts/latest — getLatestAlertMessageList(...)
  // Java: FusionDbMessageDAOChain.getLatestAlertMessageList
  // SQL:  SELECT * FROM alertmessage WHERE MinMidletVersion<=? AND MaxMidletVersion>=?
  //        AND Type=? AND (CountryID=? OR CountryID IS NULL)
  //        AND StartDate<=now() AND ExpiryDate>now()
  //        AND Status=1 AND clientType=? [AND ContentType=?]
  //        ORDER BY CountryID
  // Query params: midletVersion, type, countryId, contentType (optional), clientType
  app.get("/api/messages/alerts/latest", async (req: Request, res: Response) => {
    const midletVersion = Number(req.query.midletVersion ?? 0);
    const type = Number(req.query.type ?? 0);
    const countryId = Number(req.query.countryId ?? 0);
    const clientType = Number(req.query.clientType ?? 0);
    const contentType = req.query.contentType !== undefined ? Number(req.query.contentType) : undefined;

    const alerts = await storage.getLatestAlertMessages({ midletVersion, type, countryId, contentType, clientType });
    return res.status(200).json({ alerts });
  });

  // POST /api/messages/alerts — createAlertMessage (admin)
  app.post("/api/messages/alerts", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const parsed = insertAlertMessageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    const alert = await storage.createAlertMessage(parsed.data);
    return res.status(201).json({ alert });
  });

  // PUT /api/messages/alerts/:id — updateAlertMessage (admin)
  app.put("/api/messages/alerts/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    const updated = await storage.updateAlertMessage(id, req.body);
    if (!updated) return res.status(404).json({ message: "Alert message tidak ditemukan" });
    return res.status(200).json({ alert: updated });
  });

  // DELETE /api/messages/alerts/:id — deleteAlertMessage (admin)
  app.delete("/api/messages/alerts/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    await storage.deleteAlertMessage(id);
    return res.status(200).json({ message: "Alert message dihapus" });
  });
}
