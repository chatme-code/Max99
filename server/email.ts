const SENDER_EMAIL = "noreply@chatmeapp.my.id";
const SENDER_NAME = "MAX99";
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

export async function sendPasswordResetEmail(
  toEmail: string,
  toName: string,
  resetUrl: string
): Promise<void> {
  const maskedEmail = toEmail.replace(/(.{2}).+(@.+)/, "$1***$2");
  if (!process.env.BREVO_API_KEY) {
    console.warn("[Email] BREVO_API_KEY not set. Skipping password reset email.");
    console.log(`[Email] Reset URL for ${maskedEmail}: [REDACTED]`);
    return;
  }

  const payload = {
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    to: [{ email: toEmail, name: toName }],
    subject: "Reset Password MAX99 Kamu",
    htmlContent: `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset Password MAX99</title>
</head>
<body style="margin:0;padding:0;background:#f97316;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f97316 0%,#fb923c 52%,#ffedd5 100%);padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <tr>
            <td style="background:linear-gradient(135deg,#c2410c 0%,#f97316 100%);padding:32px;text-align:center;">
              <div style="width:64px;height:64px;background:#fff7ed;border-radius:32px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;box-shadow:0 10px 28px rgba(154,52,18,0.35);">
                <span style="color:#f97316;font-size:26px;font-weight:900;line-height:64px;display:block;">M</span>
              </div>
              <h1 style="color:#fff;margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px;">MAX99</h1>
              <p style="color:#ffedd5;margin:6px 0 0;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Chat Platform</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <h2 style="color:#9a3412;margin:0 0 12px;font-size:20px;font-weight:800;">Halo, ${toName}! 🔑</h2>
              <p style="color:#546E7A;font-size:15px;line-height:1.6;margin:0 0 24px;">
                Kami menerima permintaan untuk mereset password akun <strong style="color:#9a3412;">MAX99</strong> kamu.
                Klik tombol di bawah ini untuk membuat password baru.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${resetUrl}"
                   style="background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-size:16px;font-weight:700;display:inline-block;box-shadow:0 12px 24px rgba(249,115,22,0.25);">
                  🔑 Reset Password
                </a>
              </div>
              <p style="color:#90A4AE;font-size:13px;line-height:1.6;margin:0 0 8px;">
                Link ini berlaku selama <strong style="color:#9a3412;">1 jam</strong>.
                Jika kamu tidak meminta reset password, abaikan email ini — akun kamu tetap aman.
              </p>
              <p style="color:#B0BEC5;font-size:12px;margin:16px 0 0;word-break:break-all;">
                Atau copy link: <a href="${resetUrl}" style="color:#f97316;">${resetUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#F5F5F5;padding:20px 40px;text-align:center;border-top:1px solid #E0E0E0;">
              <p style="color:#90A4AE;font-size:12px;margin:0;">
                © 2026 MAX99 · noreply@chatmeapp.my.id
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
  };

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brevo API error ${response.status}: ${errorText}`);
  }

  console.log(`[Email] Password reset email sent to ${maskedEmail}`);
}

export async function sendVerificationEmail(
  toEmail: string,
  toName: string,
  verifyUrl: string
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    console.warn("[Email] BREVO_API_KEY not set. Skipping email send.");
    const maskedEmail = toEmail.replace(/(.{2}).+(@.+)/, "$1***$2");
    console.log(`[Email] Verification URL for ${maskedEmail}: [REDACTED]`);
    return;
  }

  const payload = {
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    to: [{ email: toEmail, name: toName }],
    subject: "Verifikasi Akun MAX99 Kamu",
    htmlContent: `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verifikasi Akun MAX99</title>
</head>
<body style="margin:0;padding:0;background:#f97316;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f97316 0%,#fb923c 52%,#ffedd5 100%);padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <tr>
            <td style="background:linear-gradient(135deg,#c2410c 0%,#f97316 100%);padding:32px;text-align:center;">
              <div style="width:64px;height:64px;background:#fff7ed;border-radius:32px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;box-shadow:0 10px 28px rgba(154,52,18,0.35);">
                <span style="color:#f97316;font-size:26px;font-weight:900;line-height:64px;display:block;">M</span>
              </div>
              <h1 style="color:#fff;margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px;">MAX99</h1>
              <p style="color:#ffedd5;margin:6px 0 0;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Chat Platform</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <h2 style="color:#9a3412;margin:0 0 12px;font-size:20px;font-weight:800;">Halo, ${toName}! 👋</h2>
              <p style="color:#546E7A;font-size:15px;line-height:1.6;margin:0 0 24px;">
                Terima kasih sudah mendaftar di <strong style="color:#9a3412;">MAX99</strong>.
                Untuk mengaktifkan akun kamu, klik tombol verifikasi di bawah ini.
              </p>
              <div style="text-align:center;margin:30px 0 32px;">
                <div style="width:76px;height:76px;border-radius:38px;background:linear-gradient(135deg,#fb923c 0%,#f97316 100%);margin:0 auto 20px;box-shadow:0 14px 28px rgba(249,115,22,0.25);">
                  <span style="color:#ffffff;font-size:42px;font-weight:900;line-height:76px;display:block;">✓</span>
                </div>
                <a href="${verifyUrl}"
                   style="background:linear-gradient(135deg,#f97316 0%,#ea580c 100%);color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-size:16px;font-weight:700;display:inline-block;box-shadow:0 12px 24px rgba(249,115,22,0.25);">
                  Verifikasi Akun
                </a>
              </div>
              <p style="color:#90A4AE;font-size:13px;line-height:1.6;margin:0 0 8px;">
                Link ini berlaku selama <strong style="color:#9a3412;">1 jam</strong>.
                Jika kamu tidak mendaftar di MAX99, abaikan email ini.
              </p>
              <p style="color:#B0BEC5;font-size:12px;margin:16px 0 0;word-break:break-all;">
                Atau copy link: <a href="${verifyUrl}" style="color:#f97316;">${verifyUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#F5F5F5;padding:20px 40px;text-align:center;border-top:1px solid #E0E0E0;">
              <p style="color:#90A4AE;font-size:12px;margin:0;">
                © 2026 MAX99 · noreply@chatmeapp.my.id
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
  };

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brevo API error ${response.status}: ${errorText}`);
  }

  const maskedEmailSent = toEmail.replace(/(.{2}).+(@.+)/, "$1***$2");
  console.log(`[Email] Verification email sent to ${maskedEmailSent}`);
}
