import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertRoomSchema } from "@shared/schema";

export function registerRoomRoutes(app: Express): void {
  app.get("/api/rooms", async (req: Request, res: Response) => {
    const rooms = await storage.getRooms();
    return res.status(200).json({ rooms });
  });

  app.get("/api/rooms/my", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const rooms = await storage.getRoomsByOwner(req.session.userId);
    return res.status(200).json({ rooms });
  });

  app.get("/api/rooms/:id", async (req: Request, res: Response) => {
    const room = await storage.getRoom(req.params.id);
    if (!room) return res.status(404).json({ message: "Room tidak ditemukan" });
    return res.status(200).json({ room });
  });

  app.post("/api/rooms", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });
    const parsed = insertRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    }
    const existing = await storage.getRoomsByOwner(req.session.userId);
    if (existing.length >= 3) {
      return res.status(403).json({ message: "Maksimum 3 room per user" });
    }
    const room = await storage.createRoom({
      ...parsed.data,
      ownerId: req.session.userId,
      ownerUsername: user.username,
    });
    return res.status(201).json({ room });
  });

  app.put("/api/rooms/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getRoom(req.params.id);
    if (!room) return res.status(404).json({ message: "Room tidak ditemukan" });
    if (room.ownerId !== req.session.userId) {
      return res.status(403).json({ message: "Hanya owner yang bisa mengedit room" });
    }
    const { name, description, theme, maxParticipants, isLocked } = req.body;
    const updated = await storage.updateRoom(req.params.id, {
      name, description, theme, maxParticipants, isLocked,
    });
    return res.status(200).json({ room: updated });
  });

  app.delete("/api/rooms/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const room = await storage.getRoom(req.params.id);
    if (!room) return res.status(404).json({ message: "Room tidak ditemukan" });
    if (room.ownerId !== req.session.userId) {
      return res.status(403).json({ message: "Hanya owner yang bisa menghapus room" });
    }
    await storage.deleteRoom(req.params.id);
    return res.status(200).json({ message: "Room dihapus" });
  });
}
