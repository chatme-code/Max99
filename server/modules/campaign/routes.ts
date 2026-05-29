import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertCampaignSchema, insertCampaignParticipantSchema } from "@shared/schema";

export function registerCampaignRoutes(app: Express): void {

  // ── Campaigns CRUD ────────────────────────────────────────────────────────

  // GET /api/campaigns — list campaigns
  // Java equiv: getCampaignData aggregation / admin listing
  app.get("/api/campaigns", async (req: Request, res: Response) => {
    const all = req.query.all === "true";
    const campaigns = await storage.getCampaigns(!all);
    return res.status(200).json({ campaigns });
  });

  // GET /api/campaigns/:id — getCampaignData(campaignId)
  // Java: FusionDbCampaignDataDAOChain.getCampaignData → SELECT * FROM campaign WHERE id = ?
  app.get("/api/campaigns/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    const campaign = await storage.getCampaign(id);
    if (!campaign) return res.status(404).json({ message: "Campaign tidak ditemukan" });
    return res.status(200).json({ campaign });
  });

  // POST /api/campaigns — create campaign (admin)
  app.post("/api/campaigns", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const parsed = insertCampaignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    const campaign = await storage.createCampaign(parsed.data);
    return res.status(201).json({ campaign });
  });

  // PUT /api/campaigns/:id — update campaign (admin)
  app.put("/api/campaigns/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    const updated = await storage.updateCampaign(id, req.body);
    if (!updated) return res.status(404).json({ message: "Campaign tidak ditemukan" });
    return res.status(200).json({ campaign: updated });
  });

  // DELETE /api/campaigns/:id — delete campaign (admin)
  app.delete("/api/campaigns/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    await storage.deleteCampaign(id);
    return res.status(200).json({ message: "Campaign dihapus" });
  });

  // ── Campaign Participants ─────────────────────────────────────────────────

  // GET /api/campaigns/:id/participants — getCampaignParticipants(campaignId)
  app.get("/api/campaigns/:id/participants", async (req: Request, res: Response) => {
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) return res.status(400).json({ message: "ID tidak valid" });
    const participants = await storage.getCampaignParticipants(campaignId);
    return res.status(200).json({ participants });
  });

  // GET /api/campaigns/:id/participants/:userId — getCampaignParticipantData(userId, campaignId)
  // Java: SELECT * FROM campaignparticipant WHERE campaignid = ? AND userid = ?
  app.get("/api/campaigns/:id/participants/:userId", async (req: Request, res: Response) => {
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) return res.status(400).json({ message: "ID tidak valid" });
    const participant = await storage.getCampaignParticipant(req.params.userId, campaignId);
    if (!participant) return res.status(404).json({ message: "Partisipan tidak ditemukan" });
    return res.status(200).json({ participant });
  });

  // GET /api/campaigns/participants/:userId/active — getActiveCampaignParticipantDataByType(userId[, type])
  // Java: SELECT cp.* FROM campaignparticipant cp JOIN campaign c ON c.id = cp.campaignid
  //       WHERE c.type=? AND cp.userid=? AND c.status=1 AND c.startdate<now() AND c.enddate>now()
  app.get("/api/campaigns/participants/:userId/active", async (req: Request, res: Response) => {
    const type = req.query.type !== undefined ? Number(req.query.type) : undefined;
    const participants = await storage.getActiveCampaignParticipants(req.params.userId, type);
    return res.status(200).json({ participants });
  });

  // GET /api/campaigns/:id/participants/mobile/:phone — getCampaignParticipantDataByMobilePhone
  // Java: SELECT * FROM campaignparticipant WHERE campaignid = ? AND mobilephone = ?
  app.get("/api/campaigns/:id/participants/mobile/:phone", async (req: Request, res: Response) => {
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) return res.status(400).json({ message: "ID tidak valid" });
    const participant = await storage.getCampaignParticipantByMobile(req.params.phone, campaignId);
    if (!participant) return res.status(404).json({ message: "Partisipan tidak ditemukan" });
    return res.status(200).json({ participant });
  });

  // POST /api/campaigns/:id/join — joinCampaign(CampaignParticipantData)
  // Java: INSERT INTO campaignparticipant (campaignid, userid, datecreated, mobilephone, emailaddress, reference)
  app.post("/api/campaigns/:id/join", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const campaignId = Number(req.params.id);
    if (isNaN(campaignId)) return res.status(400).json({ message: "ID tidak valid" });

    const campaign = await storage.getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ message: "Campaign tidak ditemukan" });
    if (campaign.status !== 1) return res.status(400).json({ message: "Campaign tidak aktif" });

    const existing = await storage.getCampaignParticipant(req.session.userId, campaignId);
    if (existing) return res.status(409).json({ message: "Sudah bergabung di campaign ini", participant: existing });

    const payload = {
      campaignId,
      userId: req.session.userId,
      mobilePhone: req.body.mobilePhone ?? null,
      emailAddress: req.body.emailAddress ?? null,
      reference: req.body.reference ?? null,
    };
    const parsed = insertCampaignParticipantSchema.safeParse(payload);
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });

    const participant = await storage.joinCampaign(parsed.data);
    return res.status(201).json({ participant });
  });
}
