import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import {
  insertMerchantTagSchema,
  MERCHANT_TAG_TYPE,
  MERCHANT_TAG_STATUS,
  MERCHANT_TAG_VALIDITY_SECONDS,
} from "@shared/schema";

// Default top merchant tag minimum amount in IDR
const MIN_TOP_MERCHANT_TAG_AMOUNT_IDR = 1_000_000;

// Default non-top merchant minimum amount in IDR
const MIN_NON_TOP_MERCHANT_TAG_AMOUNT_IDR = 100_000;

export function registerMerchantTagRoutes(app: Express): void {

  // GET /api/merchant-tags/top/minimum — get minimum top merchant tag requirements
  // mirrors MerchantResource GET /merchant/tag/top/minimum
  app.get("/api/merchant-tags/top/minimum", async (req: Request, res: Response) => {
    const currency = (req.query.currency as string) || "IDR";
    return res.status(200).json({
      validity: MERCHANT_TAG_VALIDITY_SECONDS,
      amount: MIN_TOP_MERCHANT_TAG_AMOUNT_IDR,
      currency,
      type: MERCHANT_TAG_TYPE.TOP,
      description: "Top Merchant Tag",
    });
  });

  // GET /api/merchant-tags/minimum/:countryId — get minimum non-top merchant tag details for country
  // mirrors MerchantResource GET /merchant/tag/minimum/{countryId}
  app.get("/api/merchant-tags/minimum/:countryId", async (req: Request, res: Response) => {
    const countryId = parseInt(req.params.countryId, 10);
    if (isNaN(countryId) || countryId <= 0) {
      return res.status(400).json({ message: "countryId tidak valid" });
    }
    const currency = (req.query.currency as string) || "IDR";
    return res.status(200).json({
      validity: MERCHANT_TAG_VALIDITY_SECONDS,
      amount: MIN_NON_TOP_MERCHANT_TAG_AMOUNT_IDR,
      currency,
      countryId,
      type: MERCHANT_TAG_TYPE.NON_TOP,
      description: "Non-Top Merchant Tag",
    });
  });

  // GET /api/merchant-tags — list tags with optional filters
  // Supports: merchant (merchantUsername), user (taggedUsername), type, page, numRecords
  app.get("/api/merchant-tags", async (req: Request, res: Response) => {
    const merchantUsername = req.query.merchant as string | undefined;
    const taggedUsername = req.query.user as string | undefined;
    const type = req.query.type ? Number(req.query.type) : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const numRecords = req.query.numRecords ? Number(req.query.numRecords) : 50;
    const tags = await storage.getMerchantTags({ merchantUsername, taggedUsername, type, page, numRecords });
    return res.status(200).json({ tags });
  });

  // GET /api/merchant-tags/top — get only TOP type tags for a merchant
  app.get("/api/merchant-tags/top", async (req: Request, res: Response) => {
    const merchantUsername = req.query.merchant as string | undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const numRecords = req.query.numRecords ? Number(req.query.numRecords) : 50;
    const tags = await storage.getMerchantTags({
      merchantUsername,
      type: MERCHANT_TAG_TYPE.TOP,
      page,
      numRecords,
    });
    return res.status(200).json({ tags });
  });

  // GET /api/merchant-tags/user/:username — get all active tags for a user
  // mirrors MerchantResource GET /merchant/{userid}/tags
  app.get("/api/merchant-tags/user/:username", async (req: Request, res: Response) => {
    const page = req.query.page ? Number(req.query.page) : 1;
    const numRecords = req.query.numRecords ? Number(req.query.numRecords) : 50;
    const tags = await storage.getMerchantTags({
      taggedUsername: req.params.username,
      page,
      numRecords,
    });
    return res.status(200).json({ tags });
  });

  // GET /api/merchant-tags/user/:username/expiring — get expiring tags for a user within X days
  // mirrors MerchantResource GET /merchant/{userid}/tags/expiring
  app.get("/api/merchant-tags/user/:username/expiring", async (req: Request, res: Response) => {
    const days = req.query.days ? Number(req.query.days) : 7;
    if (days < 0) {
      return res.status(400).json({ message: "Parameter 'days' tidak valid" });
    }
    const tags = await storage.getExpiringMerchantTags(req.params.username, days);
    return res.status(200).json({ tags });
  });

  // GET /api/merchant-tags/tag/:username — get active merchant tag from a tagged username
  // mirrors MerchantResource GET /merchant/tag/{username}
  app.get("/api/merchant-tags/tag/:username", async (req: Request, res: Response) => {
    const tag = await storage.getMerchantTagByUsername(req.params.username);
    if (!tag) return res.status(404).json({ message: "Tag tidak ditemukan atau sudah kadaluarsa" });
    return res.status(200).json({ tag });
  });

  // GET /api/merchant-tags/merchant/:username — list all active tags for a merchant
  app.get("/api/merchant-tags/merchant/:username", async (req: Request, res: Response) => {
    const type = req.query.type ? Number(req.query.type) : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const numRecords = req.query.numRecords ? Number(req.query.numRecords) : 50;
    const tags = await storage.getMerchantTags({ merchantUsername: req.params.username, type, page, numRecords });
    return res.status(200).json({ tags });
  });

  // GET /api/merchant-tags/merchant/:username/expiring — get expiring tags for a merchant
  // mirrors MerchantResource GET /merchant/{userid}/tags/expiring (merchant side)
  app.get("/api/merchant-tags/merchant/:username/expiring", async (req: Request, res: Response) => {
    const days = req.query.days ? Number(req.query.days) : 7;
    if (days < 0) {
      return res.status(400).json({ message: "Parameter 'days' tidak valid" });
    }
    const tags = await storage.getExpiringMerchantTags(req.params.username, days);
    return res.status(200).json({ tags });
  });

  // POST /api/merchant-tags — create a new merchant tag
  // type: 1=TOP_MERCHANT_TAG, 2=NON_TOP_MERCHANT_TAG
  // validity: MERCHANT_TAG_VALIDITY_SECONDS (43200 seconds = 12 hours)
  app.post("/api/merchant-tags", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const parsed = insertMerchantTagSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    }
    const merchant = await storage.getMerchantByUsername(parsed.data.merchantUsername);
    if (!merchant) return res.status(404).json({ message: "Merchant tidak ditemukan" });

    const validityMs = MERCHANT_TAG_VALIDITY_SECONDS * 1000;
    const expiry = new Date(Date.now() + validityMs);

    const tag = await storage.createMerchantTag({
      ...parsed.data,
      expiry,
      amount: (req.body.amount as number) ?? null,
      currency: (req.body.currency as string) ?? null,
      accountEntryId: (req.body.accountEntryId as string) ?? null,
    });
    return res.status(201).json({ tag });
  });

  // DELETE /api/merchant-tags/:id — deactivate a merchant tag (set status=INACTIVE)
  app.delete("/api/merchant-tags/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const tag = await storage.getMerchantTag(req.params.id);
    if (!tag) return res.status(404).json({ message: "Tag tidak ditemukan" });
    await storage.removeMerchantTag(req.params.id);
    return res.status(200).json({ message: "Tag dihapus" });
  });

  // GET /api/merchant-tags/constants — return tag type/status constants
  app.get("/api/merchant-tags/constants", async (_req: Request, res: Response) => {
    return res.status(200).json({
      types: [
        { value: MERCHANT_TAG_TYPE.TOP, label: "Top Merchant Tag", validitySeconds: MERCHANT_TAG_VALIDITY_SECONDS },
        { value: MERCHANT_TAG_TYPE.NON_TOP, label: "Non-Top Merchant Tag", validitySeconds: MERCHANT_TAG_VALIDITY_SECONDS },
      ],
      statuses: [
        { value: MERCHANT_TAG_STATUS.INACTIVE, label: "Inactive" },
        { value: MERCHANT_TAG_STATUS.ACTIVE, label: "Active" },
        { value: MERCHANT_TAG_STATUS.PENDING, label: "Pending" },
      ],
    });
  });
}
