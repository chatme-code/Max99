/**
 * contentGuard.ts
 *
 * Filter konten chat — tolak pesan yang berisi konfigurasi proxy/VPN, link
 * scheme proxy, atau script tag. Pesan seperti ini biasanya spam paste dari
 * user yang ingin distribusi config tanpa sepengetahuan room.
 *
 * Hasil: { blocked: boolean, reason?: string }
 */

export interface ContentCheckResult {
  blocked: boolean;
  reason?: string;
}

// Pola URI proxy/VPN (VLESS, VMess, Trojan, Shadowsocks, dll).
const PROXY_URI_RE = /\b(?:vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic|naive|wireguard|wg)\:\/\//i;

// Kata kunci konfigurasi V2Ray/Xray/sing-box. Akan match jika ditemukan
// minimal 2 kata kunci berbeda (untuk menghindari false-positive pada chat
// biasa yang kebetulan menyebut salah satunya).
const PROXY_CONFIG_KEYWORDS = [
  /"outbounds"/i,
  /"inbounds"/i,
  /"vnext"/i,
  /"protocol"\s*:\s*"(?:vless|vmess|trojan|shadowsocks|ss|hysteria2?|tuic|naive|wireguard)"/i,
  /"streamSettings"/i,
  /"settings"\s*:\s*\{/i,
  /"encryption"\s*:\s*"(?:none|auto|aes-128-gcm|chacha20-poly1305)"/i,
  /\bv2ray\b/i,
  /\bxray\b/i,
  /\bsing-?box\b/i,
];

// Script / HTML berbahaya (paranoid — chatroom client kita tidak render HTML
// tapi tetap blokir agar tidak mendorong copy-paste oleh user lain).
const SCRIPT_TAG_RE = /<\s*script\b[^>]*>|javascript\s*:|on(?:load|click|error|mouseover)\s*=/i;

export function checkMessageContent(text: string): ContentCheckResult {
  if (!text) return { blocked: false };

  // 1. Proxy URI scheme
  if (PROXY_URI_RE.test(text)) {
    return { blocked: true, reason: "proxy_uri" };
  }

  // 2. Script tag / inline JS handler
  if (SCRIPT_TAG_RE.test(text)) {
    return { blocked: true, reason: "script_tag" };
  }

  // 3. Proxy config JSON — butuh ≥ 2 kata kunci berbeda untuk dianggap config.
  let hits = 0;
  for (const re of PROXY_CONFIG_KEYWORDS) {
    if (re.test(text)) {
      hits++;
      if (hits >= 2) {
        return { blocked: true, reason: "proxy_config" };
      }
    }
  }

  return { blocked: false };
}

export function reasonToMessage(reason?: string): string {
  switch (reason) {
    case "proxy_uri":
      return "Pesan berisi link proxy/VPN tidak diizinkan.";
    case "proxy_config":
      return "Pesan berisi konfigurasi proxy/VPN tidak diizinkan.";
    case "script_tag":
      return "Pesan berisi script/HTML tidak diizinkan.";
    default:
      return "Pesan ditolak oleh filter konten.";
  }
}
