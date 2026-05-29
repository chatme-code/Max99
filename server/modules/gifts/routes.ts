import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { saveFileToDisk } from "../../utils/selfHostedUpload";

function isAdmin(req: Request): boolean {
  return !!(req as any).session?.userId;
}

export function registerAdminGiftRoutes(app: Express): void {

  // GET /api/admin/gifts — list all gifts with image info
  app.get("/api/admin/gifts", async (_req: Request, res: Response) => {
    try {
      const gifts = await storage.getVirtualGifts();
      return res.status(200).json({ gifts });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // POST /api/admin/gifts/:name/image — upload gift image ke self-hosted storage
  // Body: { base64Data: string, mimeType: string }
  app.post("/api/admin/gifts/:name/image", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });

    const schema = z.object({
      base64Data: z.string().min(1),
      mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]).default("image/png"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const giftName = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const { base64Data, mimeType } = parsed.data;

    const sizeInBytes = Math.round(base64Data.length * 0.75);
    if (sizeInBytes > 5 * 1024 * 1024) {
      return res.status(413).json({ error: "Gambar terlalu besar. Maks 5MB." });
    }

    const extMap: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
    };
    const ext      = extMap[mimeType] ?? "png";
    const fileName = `gift_${giftName}.${ext}`;

    try {
      const { url } = await saveFileToDisk({ base64Data, fileName, subfolder: "gifts" });
      await storage.updateGiftImage(giftName, url);

      return res.status(200).json({
        success:  true,
        giftName,
        imageUrl: url,
        message:  `Gambar gift '${giftName}' berhasil diupload ke self-hosted storage.`,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message ?? "Upload gagal" });
    }
  });

  // DELETE /api/admin/gifts/:name/image — remove gift image
  app.delete("/api/admin/gifts/:name/image", async (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(401).json({ message: "Unauthorized" });

    const giftName = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, "");

    try {
      await storage.updateGiftImage(giftName, null);
      return res.status(200).json({ success: true, message: `Gambar gift '${giftName}' dihapus.` });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /admin/gifts — serve admin panel HTML page
  app.get("/admin/gifts", (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Gift Image Manager</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f7fa; color: #1a202c; }
    .header { background: #09454A; color: #fff; padding: 16px 24px; }
    .header h1 { font-size: 20px; font-weight: 700; }
    .header p { font-size: 13px; opacity: 0.75; margin-top: 4px; }
    .container { max-width: 960px; margin: 32px auto; padding: 0 24px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); padding: 24px; margin-bottom: 24px; }
    .card h2 { font-size: 16px; font-weight: 700; margin-bottom: 16px; color: #09454A; }
    .gift-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; }
    .gift-item { border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; text-align: center; background: #f9fafb; }
    .gift-item img { width: 64px; height: 64px; object-fit: contain; border-radius: 8px; margin-bottom: 8px; }
    .gift-emoji { font-size: 40px; line-height: 64px; margin-bottom: 8px; display: block; }
    .gift-name { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
    .gift-price { font-size: 12px; color: #666; margin-bottom: 10px; }
    .badge-cdn { display: inline-block; background: #e6f4ea; color: #1a7340; border-radius: 4px; font-size: 10px; font-weight: 700; padding: 2px 6px; margin-bottom: 6px; }
    .btn { display: inline-block; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; }
    .btn-primary { background: #09454A; color: #fff; }
    .btn-danger { background: #e53e3e; color: #fff; margin-top: 6px; }
    .btn:hover { opacity: 0.85; }
    .upload-section { margin-top: 32px; }
    .upload-form { display: flex; flex-direction: column; gap: 12px; }
    .form-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
    select, input[type=file] { padding: 8px 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; background: #fff; }
    .status { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-top: 12px; display: none; }
    .status.success { background: #f0fff4; border: 1px solid #9ae6b4; color: #276749; display: block; }
    .status.error { background: #fff5f5; border: 1px solid #feb2b2; color: #c53030; display: block; }
    .ik-note { background: #e6f4ea; border: 1px solid #9ae6b4; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #1a7340; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎁 Gift Image Manager</h1>
    <p>Upload dan kelola gambar gift. Gambar tersimpan di self-hosted storage dan tampil di chat sebagai pengganti emoji.</p>
  </div>

  <div class="container">
    <div class="ik-note">
      <strong>Self-hosted storage aktif.</strong> Gambar yang diupload tersimpan di server sendiri (img.chatmeapp.my.id) tanpa batas quota.
    </div>

    <div class="card">
      <h2>Upload Gambar Gift</h2>
      <div class="upload-form">
        <div class="form-row">
          <div>
            <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">Pilih Gift</label>
            <select id="giftSelect" style="min-width:180px"></select>
          </div>
          <div>
            <label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">File Gambar (PNG/JPG/GIF/WEBP, max 5MB)</label>
            <input type="file" id="imageFile" accept="image/png,image/jpeg,image/gif,image/webp">
          </div>
          <button class="btn btn-primary" onclick="uploadImage()">⬆ Upload Gambar</button>
        </div>
        <div class="status" id="uploadStatus"></div>
      </div>
    </div>

    <div class="card">
      <h2>Daftar Gift</h2>
      <div class="gift-grid" id="giftGrid">
        <p style="color:#999;font-size:13px">Memuat...</p>
      </div>
    </div>
  </div>

  <script>
    let gifts = [];

    async function loadGifts() {
      try {
        const res = await fetch('/api/admin/gifts');
        const data = await res.json();
        gifts = data.gifts || [];
        renderGifts();
        renderSelect();
      } catch(e) {
        document.getElementById('giftGrid').innerHTML = '<p style="color:red">Gagal memuat gift.</p>';
      }
    }

    function renderSelect() {
      const sel = document.getElementById('giftSelect');
      sel.innerHTML = gifts.map(g => \`<option value="\${g.name}">\${g.name} (\${g.hotKey || ''})</option>\`).join('');
    }

    function renderGifts() {
      const grid = document.getElementById('giftGrid');
      grid.innerHTML = gifts.map(g => {
        const imgUrl = g.location64x64Png || null;
        const imgEl = imgUrl
          ? \`<img src="\${imgUrl}?t=\${Date.now()}" alt="\${g.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
             <span class="gift-emoji" style="display:none">\${g.hotKey || '🎁'}</span>\`
          : \`<span class="gift-emoji">\${g.hotKey || '🎁'}</span>\`;
        const cdnBadge = imgUrl ? \`<span class="badge-cdn">✓ Self-hosted</span><br>\` : '';
        const deleteBtn = imgUrl
          ? \`<br><button class="btn btn-danger" onclick="deleteImage('\${g.name}')">Hapus Gambar</button>\`
          : '';
        return \`
          <div class="gift-item" id="gift-\${g.name}">
            \${imgEl}
            \${cdnBadge}
            <div class="gift-name">\${g.name}</div>
            <div class="gift-price">IDR \${(g.price||0).toLocaleString('id-ID')}</div>
            <button class="btn btn-primary" onclick="quickUpload('\${g.name}')">Upload</button>
            \${deleteBtn}
          </div>
        \`;
      }).join('');
    }

    function quickUpload(name) {
      document.getElementById('giftSelect').value = name;
      document.getElementById('imageFile').click();
    }

    async function uploadImage() {
      const giftName = document.getElementById('giftSelect').value;
      const fileInput = document.getElementById('imageFile');

      if (!fileInput.files || !fileInput.files[0]) {
        showStatus('error', 'Pilih file gambar terlebih dahulu.');
        return;
      }

      const file = fileInput.files[0];
      const mimeType = file.type || 'image/png';

      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target.result.split(',')[1];
        try {
          showStatus('success', '⬆ Mengupload ke server...');
          const res = await fetch('/api/admin/gifts/' + giftName + '/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64Data: base64, mimeType }),
            credentials: 'include',
          });
          const data = await res.json();
          if (res.ok) {
            showStatus('success', '✓ ' + (data.message || 'Upload berhasil!'));
            await loadGifts();
          } else {
            showStatus('error', data.error || data.message || 'Upload gagal.');
          }
        } catch(err) {
          showStatus('error', 'Error: ' + err.message);
        }
      };
      reader.readAsDataURL(file);
    }

    async function deleteImage(name) {
      if (!confirm('Hapus gambar gift ' + name + '?')) return;
      try {
        const res = await fetch('/api/admin/gifts/' + name + '/image', {
          method: 'DELETE',
          credentials: 'include',
        });
        const data = await res.json();
        if (res.ok) {
          showStatus('success', data.message || 'Gambar dihapus.');
          await loadGifts();
        } else {
          showStatus('error', data.error || 'Gagal menghapus gambar.');
        }
      } catch(err) {
        showStatus('error', 'Error: ' + err.message);
      }
    }

    function showStatus(type, msg) {
      const el = document.getElementById('uploadStatus');
      el.className = 'status ' + type;
      el.textContent = msg;
    }

    document.getElementById('imageFile').addEventListener('change', () => {
      const name = document.getElementById('giftSelect').value;
      if (name) uploadImage();
    });

    loadGifts();
  </script>
</body>
</html>`);
  });
}
