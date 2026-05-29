import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { saveFileToDisk, getImgBaseUrl } from "../../utils/selfHostedUpload";

export function registerImageServerRoutes(app: Express) {

  // ── POST /api/imageserver/upload ──────────────────────────────────────────
  // Upload image/video: simpan ke disk, return URL img.chatmeapp.my.id
  // Body: { username, imageKey, mimeType, base64Data, description? }
  app.post("/api/imageserver/upload", async (req, res) => {
    const schema = z.object({
      username:    z.string().min(1),
      imageKey:    z.string().min(1),
      mimeType:    z.enum(["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/quicktime", "video/webm", "video/3gpp"]).default("image/jpeg"),
      base64Data:  z.string().min(1),
      description: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, imageKey, mimeType, base64Data, description } = parsed.data;

    const isVideo    = mimeType.startsWith("video/");
    const maxBytes   = isVideo ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
    const sizeBytes  = Math.round(base64Data.length * 0.75);
    if (sizeBytes > maxBytes) {
      return res.status(413).json({ error: isVideo ? "Video terlalu besar. Maks 50MB." : "Gambar terlalu besar. Maks 5MB." });
    }

    const extMap: Record<string, string> = {
      "image/jpeg":      "jpg",
      "image/png":       "png",
      "image/gif":       "gif",
      "image/webp":      "webp",
      "video/mp4":       "mp4",
      "video/quicktime": "mov",
      "video/webm":      "webm",
      "video/3gpp":      "3gp",
    };
    const ext       = extMap[mimeType] ?? "jpg";
    const subfolder = imageKey.startsWith("avatar_") ? "avatars" : (isVideo ? "videos" : "feed");
    const fileName  = `${imageKey}.${ext}`;

    try {
      const { url } = await saveFileToDisk({ base64Data, fileName, subfolder });
      console.log(`[imageserver] Upload OK → ${url}`);
      return res.status(201).json({
        success:  true,
        imageId:  fileName,
        imageKey: `${imageKey}.${ext}`,
        url,
        storage:  "selfhosted",
      });
    } catch (e: any) {
      // Fallback: simpan ke DB lokal jika disk gagal
      console.warn(`[imageserver] Disk upload gagal (${e?.message}), fallback ke local DB.`);
      try {
        const saved = await storage.storeImage({
          imageKey,
          username,
          mimeType,
          base64Data,
          sizeBytes,
          description: description ?? null,
        });
        return res.status(201).json({
          success:  true,
          imageId:  saved.id,
          imageKey: saved.imageKey,
          url:      `/api/imageserver/image/${saved.id}/data`,
          storage:  "local",
        });
      } catch (e2: any) {
        console.error("[imageserver] Semua storage gagal:", e2?.message);
        return res.status(500).json({ error: "Upload gagal." });
      }
    }
  });

  // ── GET /api/imageserver/image/:id ────────────────────────────────────────
  app.get("/api/imageserver/image/:id", async (req, res) => {
    const imageId = req.params.id;
    try {
      const localImage = await storage.getImageById(imageId);
      if (localImage) {
        return res.json({
          id:          localImage.id,
          imageKey:    localImage.imageKey,
          username:    localImage.username,
          mimeType:    localImage.mimeType,
          sizeBytes:   localImage.sizeBytes,
          description: localImage.description,
          url:         `/api/imageserver/image/${localImage.id}/data`,
          createdAt:   localImage.createdAt,
        });
      }
      return res.status(404).json({ error: "Image not found" });
    } catch {
      return res.status(404).json({ error: "Image not found" });
    }
  });

  // ── GET /api/imageserver/image/:id/data ──────────────────────────────────
  app.get("/api/imageserver/image/:id/data", async (req, res) => {
    const imageId = req.params.id;
    try {
      const localImage = await storage.getImageById(imageId);
      if (localImage) {
        const base64 = localImage.base64Data.includes(",")
          ? localImage.base64Data.split(",").pop()!
          : localImage.base64Data;
        const buffer = Buffer.from(base64, "base64");
        res.setHeader("Content-Type", localImage.mimeType);
        res.setHeader("Content-Length", buffer.length.toString());
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(buffer);
      }
      return res.status(404).json({ error: "Image not found" });
    } catch {
      return res.status(404).json({ error: "Image not found" });
    }
  });

  // ── GET /api/imagekit/auth — deprecated, return info ─────────────────────
  app.get("/api/imagekit/auth", (_req, res) => {
    res.status(410).json({
      error:   "ImageKit tidak lagi digunakan.",
      info:    "Upload sekarang pakai self-hosted storage.",
      imgBase: getImgBaseUrl(),
    });
  });
}
