import type { Express, Request, Response } from "express";
import { storage } from "../../storage";

export function registerEmailRoutes(app: Express): void {

  // GET /api/email/bounce/check?email=xxx — isBounceEmailAddress(email)
  // Java: FusionDbEmailDAOChain.isBounceEmailAddress
  // SQL:  SELECT bounceType FROM bouncedb WHERE emailaddress = ? LIMIT 1
  // Response: { isBounce: boolean } — true means blocked, false means safe to send
  app.get("/api/email/bounce/check", async (req: Request, res: Response) => {
    const email = (req.query.email as string)?.trim();
    if (!email) return res.status(400).json({ message: "Parameter email wajib diisi" });
    const isBounce = await storage.isBounceEmailAddress(email);
    return res.status(200).json({ email, isBounce });
  });

  // GET /api/email/bounce — list bounce emails (admin)
  app.get("/api/email/bounce", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const limit  = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Number(req.query.offset ?? 0);
    const emails = await storage.listBounceEmails(limit, offset);
    return res.status(200).json({ emails });
  });

  // POST /api/email/bounce — addBounceEmail (admin / webhook from mail provider)
  // Body: { email: string, bounceType?: "Transient" | "Permanent" }
  app.post("/api/email/bounce", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const email = (req.body.email as string)?.trim();
    if (!email) return res.status(400).json({ message: "Field email wajib diisi" });
    const bounceType = (req.body.bounceType as string) ?? "Permanent";
    await storage.addBounceEmail(email, bounceType);
    return res.status(201).json({ message: "Email bounce berhasil ditambahkan", email, bounceType });
  });

  // DELETE /api/email/bounce — removeBounceEmail (admin)
  // Body or query: { email: string }
  app.delete("/api/email/bounce", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const email = ((req.body.email ?? req.query.email) as string)?.trim();
    if (!email) return res.status(400).json({ message: "Field email wajib diisi" });
    await storage.removeBounceEmail(email);
    return res.status(200).json({ message: "Email bounce berhasil dihapus", email });
  });
}
