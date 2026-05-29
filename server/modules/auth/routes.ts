import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { loginSchema, insertUserSchema } from "@shared/schema";
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { sendVerificationEmail, sendPasswordResetEmail } from "../../email";
import { createTcpToken } from "../../gateway/tcpTokens";
import { forceLogoutCleanup } from "../../gateway";
import { signJwt } from "../../middleware/jwtAuth";
import {
  trackFailedAuth,
  getFailedAuthCount,
  resetFailedAuth,
  cacheUserHash,
  getUserHash,
  FIELD,
} from "../../redis";
import { idrToCurrency } from "../../lib/currency";
import { db } from "../../db";
import { sql } from "drizzle-orm";

const scryptAsync = promisify(scrypt);

// Max failed login attempts before temporary block (matches backend app settings)
const MAX_FAILED_ATTEMPTS = 10;

// ─── User IP tracking (used by admin panel for IP-based bulk suspend) ─────────
// Records every (username, ip) pair we observe during login and registration.
// Idempotent: table is created on first call, upsert via unique index.
let userIpLogTableReady: Promise<void> | null = null;
async function ensureUserIpLogTable(): Promise<void> {
  if (userIpLogTableReady) return userIpLogTableReady;
  userIpLogTableReady = (async () => {
    const { db } = await import("../../db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS user_ip_log (
        id          BIGSERIAL PRIMARY KEY,
        username    TEXT NOT NULL,
        ip_address  TEXT NOT NULL,
        first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        hit_count   INTEGER     NOT NULL DEFAULT 1
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ip_log_unique ON user_ip_log(username, ip_address)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_ip_log_ip ON user_ip_log(ip_address)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_ip_log_user ON user_ip_log(username)`);
  })().catch((err) => {
    console.error("[auth] ensureUserIpLogTable error:", err);
    userIpLogTableReady = null; // allow retry on next call
  }) as Promise<void>;
  return userIpLogTableReady;
}

async function recordUserIp(username: string, ip: string | null): Promise<void> {
  if (!username || !ip) return;
  try {
    await ensureUserIpLogTable();
    const { db } = await import("../../db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      INSERT INTO user_ip_log (username, ip_address, first_seen, last_seen, hit_count)
      VALUES (${username}, ${ip}, NOW(), NOW(), 1)
      ON CONFLICT (username, ip_address)
      DO UPDATE SET last_seen = NOW(), hit_count = user_ip_log.hit_count + 1
    `);
  } catch (err) {
    console.error("[auth] recordUserIp error:", err);
  }
}

// Gmail (and googlemail.com) treat dots in the local-part as invisible, so
// "j.o.h.n@gmail.com" is the same inbox as "john@gmail.com".
// We normalise before storing and before duplicate checks so users cannot
// create multiple accounts using the same real Gmail inbox.
function normalizeEmail(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const atIdx = lower.lastIndexOf("@");
  if (atIdx === -1) return lower;
  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.replace(/\./g, "")}@${domain}`;
  }
  return lower;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [hashed, salt] = hash.split(".");
  if (!hashed || !salt) return false;
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  const hashedBuf = Buffer.from(hashed, "hex");
  if (buf.length !== hashedBuf.length) return false;
  return timingSafeEqual(buf, hashedBuf);
}

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// All credit accounts are denominated in IDR regardless of the user's country.
// We still detect country (for profile/locale purposes) but never branch on it
// to pick a different currency.
function currencyForCountryCode(_countryCode: string | null): string {
  return "IDR";
}

// Formats a credit balance for display. Shown as Coins in the app UI.
export function formatCreditBalance(balance: number, _currency: string): string {
  return `🪙 ${Math.round(balance).toLocaleString("id-ID")}`;
}

interface CountryInfo {
  country: string;
  countryCode: string;
}

// Mirrors Android's onLocationCountryReceived — resolves country + country code from client IP.
// Uses ip-api.com free tier (no API key needed, max 45 req/min).
async function detectCountryFromIp(ip: string): Promise<CountryInfo | null> {
  if (!ip || ip === "unknown" || ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.")) {
    return null;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json() as { status: string; country?: string; countryCode?: string };
    if (data.status === "success" && data.country && data.countryCode) {
      return { country: data.country, countryCode: data.countryCode };
    }
  } catch {
    // Network error or timeout — silently ignore, same as Android's error handler
  }
  return null;
}

// ── GET /verify-email ──────────────────────────────────────────────────────
// Browser landing page for email verification links.
// Mirrors Android SignupEmailResult*Fragment states:
//   TOKEN_SUCCESS, TOKEN_EXPIRED, TOKEN_INVALID/TOKEN_USED, already-verified.
function verifyEmailPage(state: 'verifying' | 'success' | 'expired' | 'used' | 'error', message = ''): string {
  const icons: Record<string, string> = {
    verifying: '',
    success:   '✓',
    expired:   '!',
    used:      'i',
    error:     '×',
  };
  const colors: Record<string, string> = {
    verifying: '#f97316',
    success:   '#f97316',
    expired:   '#f59e0b',
    used:      '#2980B9',
    error:     '#E53935',
  };
  const titles: Record<string, string> = {
    verifying: 'Memverifikasi...',
    success:   'Email Terverifikasi!',
    expired:   'Link Kadaluarsa',
    used:      'Sudah Diverifikasi',
    error:     'Verifikasi Gagal',
  };
  const messages: Record<string, string> = {
    verifying: 'Harap tunggu, kami sedang memverifikasi akun kamu...',
    success:   'Akun kamu berhasil diverifikasi. Silakan login di aplikasi.',
    expired:   'Link verifikasi sudah kadaluarsa. Silakan daftar ulang.',
    used:      'Email kamu sudah diverifikasi sebelumnya. Silakan login.',
    error:     message || 'Token tidak valid atau sudah digunakan.',
  };
  const showLogin = state === 'success' || state === 'used';
  const showRegister = state === 'expired';
  const icon = icons[state];
  const color = colors[state];
  const title = titles[state];
  const msg = messages[state];

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Verifikasi Email — MAX99</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#c2410c 0%,#f97316 46%,#fdba74 100%);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:20px}
    .card{background:#fff;border-radius:24px;padding:42px 32px;max-width:420px;width:100%;text-align:center;box-shadow:0 28px 70px rgba(154,52,18,0.35)}
    .logo{width:72px;height:72px;border-radius:36px;background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;box-shadow:0 14px 28px rgba(249,115,22,0.26)}
    .brand{font-size:13px;color:#f97316;font-weight:800;letter-spacing:3px;text-transform:uppercase;margin-bottom:28px}
    .icon-wrap{width:86px;height:86px;border-radius:43px;background:linear-gradient(135deg,#fb923c 0%,#f97316 100%);color:#fff;font-size:52px;font-weight:900;line-height:86px;margin:0 auto 20px;display:block;box-shadow:0 16px 30px rgba(249,115,22,0.26)}
    .state-bar{height:4px;border-radius:999px;background:${color};margin-bottom:28px;width:78px;margin-left:auto;margin-right:auto}
    h1{font-size:24px;font-weight:800;color:#9a3412;margin-bottom:12px}
    p{font-size:15px;color:#546E7A;line-height:1.6;margin-bottom:28px}
    .btn{display:inline-block;background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:14px;font-size:16px;font-weight:800;border:none;cursor:pointer;width:100%;margin-bottom:10px;box-shadow:0 14px 26px rgba(249,115,22,0.24)}
    .btn:hover{background:linear-gradient(135deg,#fb923c 0%,#f97316 100%)}
    .btn-outline{background:transparent;border:2px solid #f97316;color:#f97316;box-shadow:none}
    .btn-outline:hover{background:#f97316;color:#fff}
    .spinner{width:48px;height:48px;border:4px solid #ffedd5;border-top:4px solid #f97316;border-radius:50%;animation:spin 0.8s linear infinite;margin:8px auto 20px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .footer{margin-top:24px;font-size:12px;color:#90A4AE}
  </style>
  ${state === 'verifying' ? `<script>
    window.addEventListener('DOMContentLoaded', function() {
      var token = new URLSearchParams(window.location.search).get('token');
      if (!token) { location.href = location.pathname + '?error=missing'; return; }
      fetch('/api/auth/verify-email?token=' + encodeURIComponent(token))
        .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, status:r.status, data:d}; }); })
        .then(function(result) {
          var s = result.status;
          if (result.ok || result.data.alreadyVerified) {
            var key = result.data.alreadyVerified ? 'used' : 'success';
            location.href = location.pathname + '?state=' + key;
          } else if (s === 410) {
            location.href = location.pathname + '?state=expired';
          } else if (s === 404) {
            location.href = location.pathname + '?state=error&msg=' + encodeURIComponent(result.data.message || '');
          } else {
            location.href = location.pathname + '?state=error&msg=' + encodeURIComponent(result.data.message || '');
          }
        })
        .catch(function() { location.href = location.pathname + '?state=error'; });
    });
  </script>` : ''}
</head>
<body>
  <div class="card">
    <div class="logo">M</div>
    <div class="brand">MAX99</div>

    ${state === 'verifying' ? `
      <div class="spinner"></div>
      <div class="state-bar"></div>
      <h1>Memverifikasi Email</h1>
      <p>Harap tunggu, kami sedang memverifikasi akun kamu...</p>
    ` : `
      <span class="icon-wrap">${icon}</span>
      <div class="state-bar" style="background:${color}"></div>
      <h1>${title}</h1>
      <p>${msg}</p>
      ${showLogin ? `<a class="btn" href="/">Buka Aplikasi</a>` : ''}
      ${showRegister ? `<a class="btn btn-outline" href="/">Daftar Ulang</a>` : ''}
      ${!showLogin && !showRegister ? `<a class="btn" href="/">Kembali ke Beranda</a>` : ''}
    `}

    <div class="footer">© 2026 MAX99 · chatmeapp.my.id</div>
  </div>
</body>
</html>`;
}

// ── Browser reset-password landing page ──────────────────────────────────────
function resetPasswordPage(state: 'form' | 'success' | 'expired' | 'error', token = '', message = ''): string {
  const colors: Record<string, string> = { form: '#f97316', success: '#f97316', expired: '#f59e0b', error: '#E53935' };
  const color = colors[state] ?? '#f97316';

  if (state === 'form') {
    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Reset Password — MAX99</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#c2410c 0%,#f97316 48%,#fdba74 100%);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:20px}
    .card{background:#fff;border-radius:20px;padding:40px 32px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
    .logo{width:72px;height:72px;border-radius:36px;background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;text-align:center;line-height:72px}
    .brand{font-size:13px;color:#f97316;font-weight:800;letter-spacing:2px;text-transform:uppercase;text-align:center;margin-bottom:28px}
    h1{font-size:20px;font-weight:800;color:#9a3412;margin-bottom:8px;text-align:center}
    p{font-size:14px;color:#546E7A;line-height:1.6;text-align:center;margin-bottom:24px}
    label{display:block;font-size:13px;font-weight:600;color:#9a3412;margin-bottom:6px}
    input{width:100%;padding:12px 14px;border:1.5px solid #E0E0E0;border-radius:10px;font-size:15px;color:#1A1A1A;outline:none;margin-bottom:14px;transition:border-color .2s}
    input:focus{border-color:#f97316}
    .btn{width:100%;background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;border:none;border-radius:12px;padding:14px;font-size:16px;font-weight:700;cursor:pointer;margin-top:6px}
    .btn:hover{background:linear-gradient(135deg,#fb923c 0%,#f97316 100%)}
    .error{background:#FFEDED;border-left:3px solid #C64F44;padding:10px 14px;border-radius:8px;color:#C64F44;font-size:13px;margin-bottom:14px;display:none}
    .footer{margin-top:24px;font-size:12px;color:#90A4AE;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">M</div>
    <div class="brand">MAX99</div>
    <h1>🔑 Buat Password Baru</h1>
    <p>Masukkan password baru untuk akun kamu.</p>
    <div class="error" id="err"></div>
    <form id="frm">
      <label>Password Baru</label>
      <input type="password" id="pw" placeholder="Minimal 6 karakter" minlength="6" required />
      <label>Konfirmasi Password</label>
      <input type="password" id="pw2" placeholder="Ulangi password baru" minlength="6" required />
      <button class="btn" type="submit">Simpan Password</button>
    </form>
    <div class="footer">© 2026 MAX99 · chatmeapp.my.id</div>
  </div>
  <script>
    document.getElementById('frm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var pw = document.getElementById('pw').value;
      var pw2 = document.getElementById('pw2').value;
      var errEl = document.getElementById('err');
      errEl.style.display = 'none';
      if (pw !== pw2) { errEl.textContent = 'Password tidak cocok.'; errEl.style.display = 'block'; return; }
      if (pw.length < 6) { errEl.textContent = 'Password minimal 6 karakter.'; errEl.style.display = 'block'; return; }
      try {
        var res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${token}', newPassword: pw }),
        });
        var data = await res.json();
        if (res.ok) {
          location.href = '/reset-password?state=success';
        } else if (res.status === 410) {
          location.href = '/reset-password?state=expired';
        } else {
          errEl.textContent = data.message || 'Terjadi kesalahan. Coba lagi.';
          errEl.style.display = 'block';
        }
      } catch(err) {
        errEl.textContent = 'Koneksi gagal. Coba lagi.';
        errEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  }

  const icons: Record<string, string> = { success: '✅', expired: '⏰', error: '❌' };
  const titles: Record<string, string> = { success: 'Password Berhasil Diubah!', expired: 'Link Kadaluarsa', error: 'Gagal Reset Password' };
  const msgs: Record<string, string> = {
    success: 'Password akun kamu sudah berhasil diubah. Silakan login dengan password baru di aplikasi.',
    expired: 'Link reset password sudah kadaluarsa (berlaku 1 jam). Silakan minta link baru.',
    error: message || 'Token tidak valid atau sudah digunakan.',
  };

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Reset Password — MAX99</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#c2410c 0%,#f97316 48%,#fdba74 100%);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:20px}
    .card{background:#fff;border-radius:20px;padding:40px 32px;max-width:420px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
    .logo{width:72px;height:72px;border-radius:36px;background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);display:inline-flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px;line-height:72px}
    .brand{font-size:13px;color:#f97316;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin-bottom:28px}
    .icon{font-size:52px;margin-bottom:16px;display:block}
    .bar{height:4px;border-radius:2px;background:${color};width:60px;margin:0 auto 24px}
    h1{font-size:22px;font-weight:800;color:#9a3412;margin-bottom:12px}
    p{font-size:15px;color:#546E7A;line-height:1.6;margin-bottom:28px}
    .btn{display:inline-block;background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:700;width:100%;margin-bottom:10px}
    .footer{margin-top:24px;font-size:12px;color:#90A4AE}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">M</div>
    <div class="brand">MAX99</div>
    <span class="icon">${icons[state]}</span>
    <div class="bar"></div>
    <h1>${titles[state]}</h1>
    <p>${msgs[state]}</p>
    <a class="btn" href="/">Buka Aplikasi</a>
    <div class="footer">© 2026 MAX99 · chatmeapp.my.id</div>
  </div>
</body>
</html>`;
}

export function registerAuthRoutes(app: Express): void {
  // ── Browser reset-password landing page ──
  app.get("/reset-password", (req: Request, res: Response) => {
    const state = req.query.state as string | undefined;
    const token = req.query.token as string | undefined;
    const msg   = req.query.msg as string | undefined;
    if (state === 'success') return res.send(resetPasswordPage('success'));
    if (state === 'expired') return res.send(resetPasswordPage('expired'));
    if (state === 'error')   return res.send(resetPasswordPage('error', '', msg));
    if (!token) return res.send(resetPasswordPage('error', '', 'Token tidak ditemukan.'));
    return res.send(resetPasswordPage('form', token));
  });

  // ── Browser email verification landing page ──
  // Called when user clicks the verification link in their email.
  // Mirrors the Android SignupEmailResult*Fragment flow.
  app.get("/verify-email", (req: Request, res: Response) => {
    const state = req.query.state as string | undefined;
    const msg   = req.query.msg as string | undefined;

    // If ?state= is set it means we already completed the API call (client-side redirect)
    if (state === 'success') return res.send(verifyEmailPage('success'));
    if (state === 'expired') return res.send(verifyEmailPage('expired'));
    if (state === 'used')    return res.send(verifyEmailPage('used'));
    if (state === 'error')   return res.send(verifyEmailPage('error', msg));

    // First load with ?token= → show the verifying spinner and kick off the API call via JS
    return res.send(verifyEmailPage('verifying'));
  });

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    // Check if registration is enabled via system_settings
    try {
      const regRow = await db.execute(sql`
        SELECT value FROM system_settings WHERE key = 'registration.enabled' LIMIT 1
      `);
      const rows = (regRow as any).rows ?? regRow;
      if (rows.length > 0 && rows[0].value === "false") {
        return res.status(403).json({
          message: "Pendaftaran akun baru sedang ditutup oleh admin. Silakan coba lagi nanti.",
          code: "REGISTRATION_DISABLED",
        });
      }
    } catch {
      // If check fails (e.g. table doesn't exist yet), allow registration to proceed
    }

    const parsed = insertUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    }
    const { username, password, displayName } = parsed.data;
    const deviceId = (req.body.device_id as string | undefined)?.trim() || null;

    // Normalise the email: strip dots from Gmail local-part to block the DOT trick.
    // We store the canonical form so duplicate detection works for all dot variants.
    const email = normalizeEmail(parsed.data.email);

    // ── Device registration limit ──────────────────────────────────────────────
    // Each physical device may register at most 5 accounts.
    const MAX_ACCOUNTS_PER_DEVICE = 5;
    if (deviceId) {
      try {
        const { db } = await import("../../db");
        const { sql } = await import("drizzle-orm");
        const countRes = await db.execute(sql`
          SELECT COUNT(*) AS cnt FROM device_registrations WHERE device_id = ${deviceId}
        `);
        const cnt = Number((countRes.rows[0] as any)?.cnt ?? 0);
        if (cnt >= MAX_ACCOUNTS_PER_DEVICE) {
          return res.status(429).json({
            message: `Perangkat ini sudah mencapai batas maksimal ${MAX_ACCOUNTS_PER_DEVICE} akun. Kamu tidak dapat membuat akun baru dari perangkat ini.`,
            code: "DEVICE_LIMIT_REACHED",
          });
        }
      } catch (err) {
        console.error("[Register] Device limit check error:", err);
        // Do not block registration if check fails — fail open
      }
    }

    const existingUsername = await storage.getUserByUsername(username);
    if (existingUsername) return res.status(409).json({ message: "Username already in use" });

    const existingEmail = await storage.getUserByEmail(email);
    if (existingEmail) return res.status(409).json({ message: "Email is already registered" });

    const hashedPassword = await hashPassword(password);
    const verifyToken = randomBytes(32).toString("hex");
    const verifyTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

    const user = await storage.createUser({
      username,
      displayName: displayName || username,
      email,
      password: hashedPassword,
      verifyToken,
      verifyTokenExpiry,
    });

    // Detect country from IP before awarding welcome credits so we can pick the right currency.
    // Mirrors Android createNewUser() + onLocationCountryReceived flow.
    // We wait up to 2 s; if detection fails we fall back to MIG.
    const clientIp = getClientIp(req);
    let countryInfo: { country: string; countryCode: string } | null = null;
    try {
      countryInfo = await Promise.race([
        detectCountryFromIp(clientIp),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
    } catch {
      // silently ignore
    }

    const creditCurrency = currencyForCountryCode(countryInfo?.countryCode ?? null);

    // Welcome bonus: every new user gets 500 IDR.
    // All accounts are IDR-denominated (no per-country currency split).
    const WELCOME_BONUS_IDR = 500;
    const welcomeAmount = idrToCurrency(WELCOME_BONUS_IDR, creditCurrency);
    const welcomeAcct = await storage.adjustBalance(username, welcomeAmount, creditCurrency);
    await storage.createCreditTransaction({
      username,
      currency: creditCurrency,
      amount: welcomeAmount,
      fundedAmount: welcomeAmount,
      tax: 0,
      runningBalance: welcomeAcct.balance,
      description: "Welcome bonus",
      type: 9, // BONUS_CREDIT — AccountEntryData.TypeEnum.BONUS_CREDIT
      reference: null,
    });

    // Save detected country to profile asynchronously
    if (countryInfo) {
      storage.upsertUserProfile(user.id, { userId: user.id, country: countryInfo.country }).catch((e) => {
        console.error("[Register] Country profile save error:", e);
      });
    }

    // Record IP for admin IP-based bulk-suspend tooling (best-effort).
    recordUserIp(username, clientIp).catch(() => {});

    // Record device registration (best-effort — never block account creation)
    if (deviceId) {
      try {
        const { db: dbInst } = await import("../../db");
        const { sql: sqlTag } = await import("drizzle-orm");
        await dbInst.execute(sqlTag`
          INSERT INTO device_registrations (device_id, username)
          VALUES (${deviceId}, ${username})
          ON CONFLICT (device_id, username) DO NOTHING
        `);
      } catch (err) {
        console.error("[Register] Device record error:", err);
      }
    }

    const verifyUrl = `${getBaseUrl(req)}/verify-email?token=${verifyToken}`;
    try {
      await sendVerificationEmail(email, displayName || username, verifyUrl);
    } catch (e) {
      console.error("[Register] Email send error:", e);
    }

    return res.status(201).json({
      message: "Your account has been created. Please check your email to verify it.",
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email },
    });
  });

  app.get("/api/auth/verify-email", async (req: Request, res: Response) => {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ message: "Invalid authentication token" });

    const user = await storage.getUserByVerifyToken(token);
    if (!user) return res.status(404).json({ message: "Token tidak ditemukan atau sudah digunakan" });

    if (user.emailVerified) {
      return res.status(200).json({ message: "Email sudah terverifikasi sebelumnya", alreadyVerified: true });
    }

    if (user.verifyTokenExpiry && user.verifyTokenExpiry < new Date()) {
      return res.status(410).json({ message: "Link verifikasi sudah kadaluarsa. Silakan daftar ulang." });
    }

    await storage.updateUser(user.id, { emailVerified: true, verifyToken: null, verifyTokenExpiry: null });
    return res.status(200).json({ message: "Email berhasil diverifikasi! Silakan login." });
  });

  // Login with Redis-backed failed auth tracking (DecayingFailedAuthsByIPScore equivalent)
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid" });

    const clientIp = getClientIp(req);
    const failedCount = await getFailedAuthCount(clientIp);

    // Block IP if exceeded max attempts (matches FAILED_AUTHS_PER_IP gate in backend)
    if (failedCount >= MAX_FAILED_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many login attempts. Please try again in a few minutes.",
        retryAfter: 900,
      });
    }

    const { username, password } = parsed.data;
    const user = await storage.getUserByUsername(username);

    if (!user) {
      await trackFailedAuth(clientIp);
      return res.status(401).json({ message: "Invalid username or password." });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      await trackFailedAuth(clientIp);
      return res.status(401).json({ message: "The username or password is incorrect." });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ message: "Please verify your account. Check your email" });
    }

    if (user.isSuspended) {
      return res.status(403).json({ message: "Your account has been suspended", suspended: true });
    }

    // Login success — reset failed count and cache user profile
    await resetFailedAuth(clientIp);

    // Record IP for admin IP-based bulk-suspend tooling (best-effort).
    recordUserIp(user.username, clientIp).catch(() => {});

    const profile = await storage.getUserProfile(user.id);
    await cacheUserHash(user.id, {
      [FIELD.USERNAME]:     user.username,
      [FIELD.DISPLAY_NAME]: user.displayName ?? user.username,
      [FIELD.MIG_LEVEL]:    String(profile?.migLevel ?? 1),
      [FIELD.STATUS]:       "online",
    });

    req.session.userId = user.id;
    const tcpToken = createTcpToken(user.id, user.username);
    const authToken = signJwt({ userId: user.id, username: user.username });
    return res.status(200).json({
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email },
      tcpToken,
      authToken,
    });
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in" });

    // Always read is_admin from DB (cheap one-row query) so it stays accurate
    // even if the cached hash predates the admin promotion.
    const user = await storage.getUser(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ message: "Invalid session" });
    }

    // Try Redis cache for the rest
    const cached = await getUserHash(req.session.userId);
    if (cached && cached[FIELD.USERNAME]) {
      return res.status(200).json({
        user: {
          id:          req.session.userId,
          username:    cached[FIELD.USERNAME],
          displayName: cached[FIELD.DISPLAY_NAME] || cached[FIELD.USERNAME],
          email:       user.email,
          isAdmin:     user.isAdmin === true,
        },
        fromCache: true,
      });
    }

    // Populate cache for next time
    await cacheUserHash(user.id, {
      [FIELD.USERNAME]:     user.username,
      [FIELD.DISPLAY_NAME]: user.displayName ?? user.username,
      [FIELD.STATUS]:       "online",
    });

    return res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        isAdmin: user.isAdmin === true,
      },
    });
  });

  // ── POST /api/auth/forgot-password ──────────────────────────────────────
  // Request a password reset — accepts email or username
  // Sends a reset link to the registered email address.
  // Always returns 200 to prevent user enumeration.
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const { emailOrUsername } = req.body as { emailOrUsername?: string };
    if (!emailOrUsername || emailOrUsername.trim().length === 0) {
      return res.status(400).json({ message: "Email atau username wajib diisi." });
    }
    const input = emailOrUsername.trim();

    try {
      // Look up by email first, then by username
      let user = await storage.getUserByEmail(input);
      if (!user) user = await storage.getUserByUsername(input);

      // Always return success to avoid user enumeration
      if (!user) {
        return res.status(200).json({ message: "Jika akun ditemukan, link reset password sudah dikirim ke email kamu." });
      }

      const resetToken = randomBytes(32).toString("hex");
      const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await storage.updateUser(user.id, { resetToken, resetTokenExpiry });

      const resetUrl = `${getBaseUrl(req)}/reset-password?token=${resetToken}`;
      try {
        await sendPasswordResetEmail(user.email, user.displayName || user.username, resetUrl);
      } catch (e) {
        console.error("[ForgotPassword] Email send error:", e);
      }

      return res.status(200).json({ message: "Jika akun ditemukan, link reset password sudah dikirim ke email kamu." });
    } catch (e) {
      console.error("[ForgotPassword] Error:", e);
      return res.status(500).json({ message: "Terjadi kesalahan. Coba lagi." });
    }
  });

  // ── POST /api/auth/reset-password ────────────────────────────────────────
  // Set a new password using a valid reset token
  // Body: { token, newPassword }
  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    const { token, newPassword } = req.body as { token?: string; newPassword?: string };
    if (!token || !newPassword) {
      return res.status(400).json({ message: "Token dan password baru wajib diisi." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password minimal 6 karakter." });
    }

    try {
      const user = await storage.getUserByResetToken(token);
      if (!user) {
        return res.status(404).json({ message: "Token tidak valid atau sudah digunakan." });
      }
      if (user.resetTokenExpiry && user.resetTokenExpiry < new Date()) {
        return res.status(410).json({ message: "Link reset password sudah kadaluarsa. Silakan minta link baru." });
      }

      const hashed = await hashPassword(newPassword);
      await storage.updateUser(user.id, {
        password: hashed,
        resetToken: null,
        resetTokenExpiry: null,
      });

      return res.status(200).json({ message: "Password berhasil diubah. Silakan login dengan password baru." });
    } catch (e) {
      console.error("[ResetPassword] Error:", e);
      return res.status(500).json({ message: "Terjadi kesalahan. Coba lagi." });
    }
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    // Mirrors Java HomeNavigationActivity.logout(): immediately leave every
    // chatroom the user is in and broadcast "has left" — even when the
    // mobile WebSocket has already closed (e.g. app was backgrounded).
    // Without this, the gateway's 8h background grace timer keeps the
    // user visible in the participants sidebar long after they switched
    // accounts, and "[username] has left" never appears.
    const userId = req.session.userId;
    if (userId) {
      try {
        await forceLogoutCleanup(userId);
      } catch (e) {
        console.warn("[auth/logout] forceLogoutCleanup failed:", (e as any)?.message);
      }
    }
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      return res.status(200).json({ message: "You have been logged out" });
    });
  });

  app.post("/api/auth/change-password", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in" });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Both old and new passwords must be filled in" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });

    const valid = await verifyPassword(currentPassword, user.password);
    if (!valid) return res.status(401).json({ message: "The old password is incorrect" });

    const hashed = await hashPassword(newPassword);
    await storage.updateUser(user.id, { password: hashed });
    return res.status(200).json({ message: "Your password has been successfully updated" });
  });

  app.post("/api/auth/change-email", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in" });
    const { newEmail } = req.body;
    if (!newEmail || !newEmail.includes("@")) {
      return res.status(400).json({ message: "Please enter a valid email address" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });

    // Normalise the new email so Gmail DOT trick cannot bypass uniqueness on change too
    const normalizedNew = normalizeEmail(newEmail);
    const existingEmail = await storage.getUserByEmail(normalizedNew);
    if (existingEmail && existingEmail.id !== user.id) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    await storage.updateUser(user.id, { email: normalizedNew });
    return res.status(200).json({ message: "Email address has been successfully updated" });
  });

  // ── Ensure google columns exist on users table (runs once at startup) ────
  db.execute(sql`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ
  `).catch(() => {});

  // ── POST /api/auth/change-username ───────────────────────────────────────
  // Allows Google-login users to change their auto-generated username once.
  app.post("/api/auth/change-username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });

    const newUsername = (req.body.username as string | undefined)?.trim().toLowerCase();
    if (!newUsername) return res.status(400).json({ message: "Username wajib diisi" });

    // Validate same rules as register
    if (newUsername.length < 6)
      return res.status(400).json({ message: "Username minimal 6 karakter" });
    if (newUsername.length > 18)
      return res.status(400).json({ message: "Username maksimal 18 karakter" });
    if (!/^[a-z]/.test(newUsername))
      return res.status(400).json({ message: "Username harus diawali dengan huruf kecil" });
    if (!/^[a-z][a-z0-9_]*$/.test(newUsername))
      return res.status(400).json({ message: "Username hanya boleh huruf kecil, angka, dan underscore" });

    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });

    // Only Google users can change username
    const userRow = await db.execute(sql`SELECT google_sub, username_changed_at FROM users WHERE id = ${user.id} LIMIT 1`);
    const row = (userRow.rows as any[])[0];
    if (!row?.google_sub)
      return res.status(403).json({ message: "Fitur ini hanya untuk akun yang login via Google" });
    if (row?.username_changed_at)
      return res.status(403).json({ message: "Username sudah pernah diganti. Hanya boleh 1 kali." });

    // Check availability
    const taken = await storage.getUserByUsername(newUsername);
    if (taken && taken.id !== user.id)
      return res.status(409).json({ message: `Username @${newUsername} sudah dipakai` });

    const oldUsername = user.username;
    const now = new Date();

    // Update in a transaction across all key tables
    await db.execute(sql`
      UPDATE users                SET username = ${newUsername}, username_changed_at = ${now.toISOString()} WHERE id = ${user.id};
      UPDATE wall_posts            SET author_username = ${newUsername} WHERE author_username = ${oldUsername};
      UPDATE messages              SET sender_username = ${newUsername} WHERE sender_username = ${oldUsername};
      UPDATE contacts              SET username = ${newUsername}        WHERE username = ${oldUsername};
      UPDATE contact_groups        SET username = ${newUsername}        WHERE username = ${oldUsername};
      UPDATE user_settings         SET username = ${newUsername}        WHERE username = ${oldUsername};
      UPDATE user_privacy_settings SET username = ${newUsername}        WHERE username = ${oldUsername};
      UPDATE user_reputation       SET username = ${newUsername}        WHERE username = ${oldUsername};
      UPDATE party_rooms           SET creator_username = ${newUsername} WHERE creator_username = ${oldUsername};
      UPDATE host_salary_contracts SET username = ${newUsername}        WHERE username = ${oldUsername};
      UPDATE host_salary_weekly_logs SET username = ${newUsername}      WHERE username = ${oldUsername};
    `).catch(async () => {
      // Fallback: update one by one
      await db.execute(sql`UPDATE users SET username = ${newUsername}, username_changed_at = ${now.toISOString()} WHERE id = ${user.id}`);
      for (const q of [
        sql`UPDATE wall_posts SET author_username = ${newUsername} WHERE author_username = ${oldUsername}`,
        sql`UPDATE messages SET sender_username = ${newUsername} WHERE sender_username = ${oldUsername}`,
        sql`UPDATE contacts SET username = ${newUsername} WHERE username = ${oldUsername}`,
        sql`UPDATE contact_groups SET username = ${newUsername} WHERE username = ${oldUsername}`,
        sql`UPDATE user_settings SET username = ${newUsername} WHERE username = ${oldUsername}`,
        sql`UPDATE user_privacy_settings SET username = ${newUsername} WHERE username = ${oldUsername}`,
        sql`UPDATE user_reputation SET username = ${newUsername} WHERE username = ${oldUsername}`,
        sql`UPDATE party_rooms SET creator_username = ${newUsername} WHERE creator_username = ${oldUsername}`,
        sql`UPDATE host_salary_contracts SET username = ${newUsername} WHERE username = ${oldUsername}`,
        sql`UPDATE host_salary_weekly_logs SET username = ${newUsername} WHERE username = ${oldUsername}`,
      ]) { await db.execute(q).catch(() => {}); }
    });

    // Update session cache
    await cacheUserHash(user.id, {
      [FIELD.USERNAME]: newUsername,
    }).catch(() => {});

    return res.status(200).json({ success: true, username: newUsername });
  });

  // ── POST /api/auth/google ────────────────────────────────────────────────
  // Verifies a Google ID token, then logs in or auto-registers the user.
  // No password needed — Google has already verified the identity.
  app.post("/api/auth/google", async (req: Request, res: Response) => {
    const { idToken } = req.body as { idToken?: string };
    if (!idToken) return res.status(400).json({ message: "idToken wajib diisi" });

    // Verify id_token with Google tokeninfo endpoint
    let googleEmail: string;
    let googleName: string | undefined;
    let googleSub: string;
    try {
      const resp = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) return res.status(401).json({ message: "Token Google tidak valid" });
      const data = await resp.json() as Record<string, string>;
      if (!data.email || !data.sub) return res.status(401).json({ message: "Token Google tidak valid" });
      googleEmail = data.email;
      googleName  = data.name;
      googleSub   = data.sub;
    } catch {
      return res.status(401).json({ message: "Gagal verifikasi token Google. Coba lagi." });
    }

    const normalizedEmail = normalizeEmail(googleEmail);

    // Find existing user by email
    let user = await storage.getUserByEmail(normalizedEmail);

    if (!user) {
      // Auto-register: generate a short random username (6 alphanumeric chars).
      // NOTE: Google auto-register is intentionally NOT blocked by registration toggle.
      // Only manual form registration (POST /api/auth/register) checks the toggle.
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      const genShortUsername = () =>
        Array.from(randomBytes(6)).map(b => chars[b % chars.length]).join("");

      let username = genShortUsername();
      // Retry up to 5 times on collision (extremely unlikely)
      for (let i = 0; i < 5; i++) {
        const existing = await storage.getUserByUsername(username);
        if (!existing) break;
        username = genShortUsername();
      }
      const randomPw  = await hashPassword(randomBytes(20).toString("hex"));

      user = await storage.createUser({
        username,
        email:         normalizedEmail,
        password:      randomPw,
        displayName:   googleName || username,
        emailVerified: true,
      });

      // Store google_sub for the new Google user
      await db.execute(sql`UPDATE users SET google_sub = ${googleSub} WHERE id = ${user.id}`).catch(() => {});

      // Best-effort profile + reputation init (mirrors register flow)
      try { await storage.createUserReputation(user.username); } catch {}
    } else if (!user.emailVerified) {
      // User registered before (via email/password) but hasn't verified yet.
      // Google has already verified ownership of this email — mark it verified now.
      await storage.updateUser(user.id, {
        emailVerified: true,
        verifyToken: null,
        verifyTokenExpiry: null,
      });
      user = { ...user, emailVerified: true };
    }

    if (user.isSuspended) {
      return res.status(403).json({ message: "Akun telah disuspend", suspended: true });
    }

    const clientIp = getClientIp(req);
    recordUserIp(user.username, clientIp).catch(() => {});

    const profile = await storage.getUserProfile(user.id);
    await cacheUserHash(user.id, {
      [FIELD.USERNAME]:     user.username,
      [FIELD.DISPLAY_NAME]: user.displayName ?? user.username,
      [FIELD.MIG_LEVEL]:    String(profile?.migLevel ?? 1),
      [FIELD.STATUS]:       "online",
    });

    req.session.userId = user.id;
    const tcpToken  = createTcpToken(user.id, user.username);
    const authToken = signJwt({ userId: user.id, username: user.username });

    return res.status(200).json({
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email },
      tcpToken,
      authToken,
    });
  });
}
