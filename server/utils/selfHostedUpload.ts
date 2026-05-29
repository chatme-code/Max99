/**
 * selfHostedUpload.ts — Utility upload file ke disk lokal, serve via img.chatmeapp.my.id
 *
 * Flow:
 *   1. Terima base64Data + metadata
 *   2. Simpan file ke /app/uploads/{subfolder}/{filename}
 *   3. Return URL publik: https://img.chatmeapp.my.id/{subfolder}/{filename}
 *
 * ENV:
 *   IMG_BASE_URL  — base URL CDN (default: https://img.chatmeapp.my.id)
 *   UPLOADS_DIR   — path lokal folder uploads (default: ./uploads relatif ke cwd)
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export function getImgBaseUrl(): string {
  return (process.env.IMG_BASE_URL ?? "https://img.chatmeapp.my.id").replace(/\/$/, "");
}

export function getUploadsDir(): string {
  return process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads");
}

export interface SaveFileOpts {
  base64Data: string;
  fileName:   string;
  subfolder:  string;
}

export interface SaveFileResult {
  url:      string;
  filePath: string;
}

/**
 * Simpan file base64 ke disk dan return URL publik.
 * Subfolder contoh: "avatars", "feed", "gifts", "party/images", "party/lottie", "party/video"
 */
export async function saveFileToDisk(opts: SaveFileOpts): Promise<SaveFileResult> {
  const uploadsDir = getUploadsDir();
  const subDir     = path.join(uploadsDir, opts.subfolder);

  if (!existsSync(subDir)) {
    await mkdir(subDir, { recursive: true });
  }

  const buffer   = Buffer.from(opts.base64Data, "base64");
  const filePath = path.join(subDir, opts.fileName);
  await writeFile(filePath, buffer);

  const url = `${getImgBaseUrl()}/${opts.subfolder}/${opts.fileName}`;
  console.log(`[selfHostedUpload] Saved: ${filePath} → ${url}`);

  return { url, filePath };
}
