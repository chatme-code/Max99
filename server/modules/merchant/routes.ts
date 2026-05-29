import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import {
  insertMerchantSchema,
  insertMerchantLocationSchema,
  MERCHANT_TYPE,
  MERCHANT_USERNAME_COLOR_TYPE,
  MERCHANT_POINTS_ENTRY_TYPE,
} from "@shared/schema";
import { enrichMerchantsWithAvatar } from "../../utils/merchantAvatar";

export function registerMerchantRoutes(app: Express): void {

  // GET /api/merchants/countries — list all countries that have merchant locations
  // mirrors MerchantResource GET /merchant/countries
  app.get("/api/merchants/countries", async (_req: Request, res: Response) => {
    const countries = await storage.getCountriesWithMerchants();
    return res.status(200).json({ countries });
  });

  // GET /api/merchants/country/search?name=&offset=&limit= — search by country name
  // mirrors MerchantResource GET /merchant/country/search
  app.get("/api/merchants/country/search", async (req: Request, res: Response) => {
    const name = (req.query.name as string) ?? "";
    const offset = Number(req.query.offset) || 0;
    const limit = Number(req.query.limit) || 20;
    if (!name) return res.status(400).json({ message: "Parameter 'name' wajib diisi" });
    const locations = await storage.getMerchantLocationsByCountryName(name, offset, limit);
    return res.status(200).json({ locations });
  });

  // GET /api/merchants/country/:id?offset=&limit= — get merchant locations by country ID
  // mirrors MerchantResource GET /merchant/country/{id}
  app.get("/api/merchants/country/:id", async (req: Request, res: Response) => {
    const countryId = parseInt(req.params.id, 10);
    if (isNaN(countryId) || countryId <= 0) {
      return res.status(400).json({ message: "countryId tidak valid" });
    }
    const offset = Number(req.query.offset) || 0;
    const limit = Number(req.query.limit) || 20;
    const locations = await storage.getMerchantLocationsByCountryId(countryId, offset, limit);
    return res.status(200).json({ locations });
  });

  // GET /api/merchants/types — return merchant type constants (must be before /:username)
  app.get("/api/merchants/types", async (_req: Request, res: Response) => {
    return res.status(200).json({
      types: [
        { value: MERCHANT_TYPE.MERCHANT, label: "Merchant" },
        { value: MERCHANT_TYPE.MENTOR, label: "Mentor" },
        { value: MERCHANT_TYPE.HEAD_MENTOR, label: "HeadMentor" },
      ],
      colorTypes: [
        { value: MERCHANT_USERNAME_COLOR_TYPE.DEFAULT, label: "Default", hex: "#990099" },
        { value: MERCHANT_USERNAME_COLOR_TYPE.RED, label: "Red", hex: "#FF0000" },
        { value: MERCHANT_USERNAME_COLOR_TYPE.PINK, label: "Pink", hex: "#FF69B4" },
      ],
      pointsEntryTypes: [
        { value: MERCHANT_POINTS_ENTRY_TYPE.MANUAL_ADJUSTMENT, label: "Manual Adjustment" },
        { value: MERCHANT_POINTS_ENTRY_TYPE.MECHANIC_REWARD, label: "Mechanic Reward" },
      ],
    });
  });

  // GET /api/merchants — list all merchants with optional category / search filter
  app.get("/api/merchants", async (req: Request, res: Response) => {
    const category = req.query.category as string | undefined;
    const search = req.query.search as string | undefined;
    const merchantType = req.query.type ? Number(req.query.type) : undefined;
    let merchants = await storage.getMerchants();
    if (category) {
      merchants = merchants.filter((m) => m.category === category);
    }
    if (search) {
      const q = search.toLowerCase();
      merchants = merchants.filter(
        (m) => m.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
      );
    }
    if (merchantType !== undefined) {
      merchants = merchants.filter((m) => m.merchantType === merchantType);
    }
    const enriched = await enrichMerchantsWithAvatar(merchants);
    return res.status(200).json({ merchants: enriched });
  });

  // GET /api/merchants/:username — get merchant detail with locations
  app.get("/api/merchants/:username", async (req: Request, res: Response) => {
    const merchant = await storage.getMerchantByUsername(req.params.username);
    if (!merchant) return res.status(404).json({ message: "Merchant tidak ditemukan" });
    const locations = await storage.getMerchantLocations(req.params.username);
    const [enriched] = await enrichMerchantsWithAvatar([merchant]);
    return res.status(200).json({ merchant: enriched, locations });
  });

  // POST /api/merchants — create a new merchant
  app.post("/api/merchants", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const parsed = insertMerchantSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    }
    const existing = await storage.getMerchantByUsername(parsed.data.username);
    if (existing) return res.status(409).json({ message: "Username merchant sudah digunakan" });
    const merchant = await storage.createMerchant(parsed.data);
    return res.status(201).json({ merchant });
  });

  // PUT /api/merchants/:username — update merchant profile
  app.put("/api/merchants/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const merchant = await storage.getMerchantByUsername(req.params.username);
    if (!merchant) return res.status(404).json({ message: "Merchant tidak ditemukan" });
    const updated = await storage.updateMerchant(req.params.username, req.body);
    return res.status(200).json({ merchant: updated });
  });

  // POST /api/merchants/:username/details/username_color — set username color type
  // mirrors MerchantResource POST /merchant/{userid}/details/username_color
  // colorType: 0=DEFAULT (#990099), 1=RED (#FF0000), 2=PINK (#FF69B4)
  app.post("/api/merchants/:username/details/username_color", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const merchant = await storage.getMerchantByUsername(req.params.username);
    if (!merchant) return res.status(404).json({ message: "Merchant tidak ditemukan" });
    const colorType = Number(req.body.color);
    const validColors = Object.values(MERCHANT_USERNAME_COLOR_TYPE);
    if (isNaN(colorType) || !validColors.includes(colorType as any)) {
      return res.status(400).json({
        message: `Color type tidak valid. Gunakan: 0 (DEFAULT), 1 (RED), 2 (PINK)`,
      });
    }
    const updated = await storage.updateMerchantColorType(req.params.username, colorType);
    return res.status(200).json({ merchant: updated });
  });

  // POST /api/merchants/:username/locations — add a location to a merchant
  app.post("/api/merchants/:username/locations", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const merchant = await storage.getMerchantByUsername(req.params.username);
    if (!merchant) return res.status(404).json({ message: "Merchant tidak ditemukan" });
    const parsed = insertMerchantLocationSchema.safeParse({
      ...req.body,
      merchantUsername: req.params.username,
    });
    if (!parsed.success) {
      return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    }
    const location = await storage.createMerchantLocation(parsed.data);
    return res.status(201).json({ location });
  });

  // GET /api/merchants/:username/locations — get all locations for a merchant
  app.get("/api/merchants/:username/locations", async (req: Request, res: Response) => {
    const locations = await storage.getMerchantLocations(req.params.username);
    return res.status(200).json({ locations });
  });

  // POST /api/merchants/:username/points — reward points to a user from a merchant
  // entryType: 1=MANUAL_ADJUSTMENT, 2=MECHANIC_REWARD (mirrors MerchantPointsLogData.EntryTypeEnum)
  app.post("/api/merchants/:username/points", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const merchant = await storage.getMerchantByUsername(req.params.username);
    if (!merchant) return res.status(404).json({ message: "Merchant tidak ditemukan" });
    const { points, reason, entryType } = req.body;
    if (!points || typeof points !== "number") {
      return res.status(400).json({ message: "Jumlah poin tidak valid" });
    }
    const resolvedEntryType = entryType ?? MERCHANT_POINTS_ENTRY_TYPE.MANUAL_ADJUSTMENT;
    if (![MERCHANT_POINTS_ENTRY_TYPE.MANUAL_ADJUSTMENT, MERCHANT_POINTS_ENTRY_TYPE.MECHANIC_REWARD].includes(resolvedEntryType)) {
      return res.status(400).json({ message: "entryType tidak valid. Gunakan 1 (MANUAL_ADJUSTMENT) atau 2 (MECHANIC_REWARD)" });
    }
    const log = await storage.addMerchantPoints(req.params.username, req.session.userId, points, resolvedEntryType, reason);
    return res.status(201).json({ log });
  });

  // GET /api/merchants/:username/points/:userId — get user total points with merchant
  app.get("/api/merchants/:username/points/:userId", async (req: Request, res: Response) => {
    const total = await storage.getUserMerchantPoints(req.params.username, req.params.userId);
    const history = await storage.getMerchantPointsHistory(req.params.username, req.params.userId);
    return res.status(200).json({
      merchantUsername: req.params.username,
      userId: req.params.userId,
      totalPoints: total,
      history,
    });
  });

  // POST /api/merchants/:username/resetmerchantpin — reset merchant PIN
  // mirrors MerchantResource POST /merchant/{username}/resetmerchantpin
  app.post("/api/merchants/:username/resetmerchantpin", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const merchant = await storage.getMerchantByUsername(req.params.username);
    if (!merchant) return res.status(404).json({ message: "Merchant tidak ditemukan" });
    return res.status(200).json({ success: true, message: "Merchant PIN telah direset" });
  });

}
