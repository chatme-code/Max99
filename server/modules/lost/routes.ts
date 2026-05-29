import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertLostContactSchema } from "@shared/schema";

export function registerLostRoutes(app: Express): void {
  app.get("/api/lost", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const contacts = await storage.getLostContacts(req.session.userId);
    return res.status(200).json({ contacts });
  });

  app.post("/api/lost", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const parsed = insertLostContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    }
    const contact = await storage.createLostContact({
      userId: req.session.userId,
      ...parsed.data,
    });
    return res.status(201).json({ contact });
  });

  app.get("/api/lost/search", async (req: Request, res: Response) => {
    const q = req.query.q as string;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ message: "Query pencarian minimal 2 karakter" });
    }
    const users = await storage.searchUsers(q.trim());
    return res.status(200).json({ users });
  });

  app.delete("/api/lost/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const contact = await storage.getLostContact(req.params.id);
    if (!contact) return res.status(404).json({ message: "Kontak tidak ditemukan" });
    if (contact.userId !== req.session.userId) {
      return res.status(403).json({ message: "Tidak diizinkan" });
    }
    await storage.deleteLostContact(req.params.id);
    return res.status(200).json({ message: "Kontak dihapus dari daftar" });
  });

  app.put("/api/lost/:id/found", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const contact = await storage.getLostContact(req.params.id);
    if (!contact) return res.status(404).json({ message: "Kontak tidak ditemukan" });
    if (contact.userId !== req.session.userId) {
      return res.status(403).json({ message: "Tidak diizinkan" });
    }
    const updated = await storage.updateLostContactStatus(req.params.id, 0);
    return res.status(200).json({ contact: updated, message: "Kontak ditandai ditemukan" });
  });
}
