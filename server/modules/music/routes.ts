import type { Express } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { verifyJwt } from "../../middleware/jwtAuth";

// ── Storage: uploads/music/<timestamp>_<random>.<ext> ─────────────────────────
const MUSIC_DIR = path.join(process.cwd(), "uploads", "music");

function ensureMusicDir() {
  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureMusicDir();
    cb(null, MUSIC_DIR);
  },
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname) || ".mp3";
    const name = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) return cb(null, true);
    cb(new Error("Hanya file audio yang diizinkan"));
  },
});

// Auto-cleanup: hapus file musik > 3 jam
function scheduleCleanup() {
  setInterval(() => {
    try {
      if (!fs.existsSync(MUSIC_DIR)) return;
      const now = Date.now();
      const files = fs.readdirSync(MUSIC_DIR);
      for (const f of files) {
        const fp = path.join(MUSIC_DIR, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > 3 * 60 * 60 * 1000) {
            fs.unlinkSync(fp);
          }
        } catch { /* skip */ }
      }
    } catch { /* non-critical */ }
  }, 30 * 60 * 1000); // cek setiap 30 menit
}

scheduleCleanup();

function getServerBase(req: Express["request"]): string {
  // PUBLIC_API_URL env var takes priority (needed behind Docker/nginx reverse proxy)
  // Contoh: PUBLIC_API_URL=https://api.chatmeapp.my.id
  if (process.env.PUBLIC_API_URL) {
    return process.env.PUBLIC_API_URL.replace(/\/$/, "");
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers.host || "";
  return `${proto}://${host}`;
}

export function registerMusicRoutes(app: Express) {
  // POST /api/music/upload — upload file audio lokal, return public URL
  app.post("/api/music/upload", (req, res) => {
    // Verify JWT
    const auth = req.headers["authorization"];
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.query.token as string);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: "Invalid token" });

    upload.single("audio")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Upload gagal" });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Tidak ada file yang diupload" });
      }

      const base = getServerBase(req);
      const url  = `${base}/uploads/music/${req.file.filename}`;
      res.json({ url, filename: req.file.filename });
    });
  });
}
