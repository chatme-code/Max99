import type { Express, Request, Response } from "express";

const SUPPORTED_COMMANDS: Record<string, string> = {
  migStore: "Open Mig Store",
  joinChatroom: "Join chatroom by ID",
  searchTopic: "Search topic / hot topic",
  privateChat: "Mulai private chat dengan username",
  joinGroupChatroom: "Join group chatroom (roomId, linkedId)",
  showGroup: "Show group page by groupId",
  chat: "Show chatroom list",
  login: "Show login page",
  url: "Open URL in browser",
  profile: "Show user profile by username",
  mygroups: "Show my groups",
  groupList: "Show all groups list",
  migWorld: "Open migWorld browser",
  hotTopics: "Show hot topics",
  recommendedUsers: "Show recommended users",
  logout: "Lakukan logout",
  ssologin: "SSO login (Facebook, dll)",
  ssologinFiksu: "SSO login via Fiksu",
  syncPhoneAddressBook: "Sinkronisasi phonebook",
  showPost: "Show post (postId, isGroup?)",
  share: "Show sharebox with content",
  sendGift: "Kirim gift (recipient, giftId, context?)",
  showFollowers: "Show followers list",
  showBadges: "Show badges list",
  showInviteFriends: "Show invite friends page",
  goGamePage: "Open Game Centre",
  auth: "Autentikasi session",
  closeBrowser: "Close in-app browser",
  showChatroomUsers: "Show users in chatroom",
  showFriends: "Show friends list",
  friend: "Show friends list",
  groupChat: "Mulai group chat",
  help: "Show help page",
  showIMManager: "Show IM manager",
  mentions: "Show mentions",
  invokeNativeBrowser: "Open native browser",
  showPhoneBook: "Show phonebook",
  recommendations: "Show recommendations",
  settings: "Open settings",
  updateStatus: "Update status",
  watchlist: "Show watchlist",
};

const MIG_CMD_PATTERN = /^mig33:([a-zA-Z0-9_]+)(?:\((['"]?)([^)]*)\2\))?$/;

function parseMigCommandUrl(url: string): { command: string; params: string[] } | null {
  const trimmed = url.trim();
  const m = MIG_CMD_PATTERN.exec(trimmed);
  if (!m) return null;

  const command = m[1];
  const rawParams = m[3] ?? "";

  let params: string[] = [];
  if (rawParams.trim().length > 0) {
    try {
      const decoded = decodeURIComponent(rawParams);
      params = decoded.split(/,\s*/).map((p) => p.trim());
    } catch {
      params = rawParams.split(/,\s*/).map((p) => p.trim());
    }
  }

  return { command, params };
}

export function registerMigCommandRoutes(app: Express): void {
  app.get("/api/migcommand/supported", (_req: Request, res: Response) => {
    const list = Object.entries(SUPPORTED_COMMANDS).map(([command, description]) => ({
      command,
      url: `mig33:${command}`,
      description,
    }));
    return res.status(200).json({ commands: list, total: list.length });
  });

  app.post("/api/migcommand/resolve", (req: Request, res: Response) => {
    const { url } = req.body as { url?: string };
    if (!url || typeof url !== "string") {
      return res.status(400).json({ message: "Field 'url' wajib diisi (contoh: mig33:joinChatroom('roomId'))" });
    }

    const parsed = parseMigCommandUrl(url);
    if (!parsed) {
      return res.status(400).json({
        message: "URL bukan format MigCommand yang valid",
        hint: "Format: mig33:command atau mig33:command('param1,param2')",
      });
    }

    const { command, params } = parsed;
    const description = SUPPORTED_COMMANDS[command] ?? null;
    const supported = description !== null;

    return res.status(200).json({
      url,
      command,
      params,
      supported,
      description: description ?? "Unknown command",
    });
  });

  app.post("/api/migcommand/resolve/batch", (req: Request, res: Response) => {
    const { urls } = req.body as { urls?: unknown };
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ message: "Field 'urls' must be a non-empty array of strings" });
    }
    if (urls.length > 100) {
      return res.status(400).json({ message: "Maksimal 100 URL per request" });
    }

    const results = (urls as string[]).map((url) => {
      if (typeof url !== "string") {
        return { url, error: "Not a string" };
      }
      const parsed = parseMigCommandUrl(url);
      if (!parsed) {
        return { url, error: "Invalid format" };
      }
      const { command, params } = parsed;
      const description = SUPPORTED_COMMANDS[command] ?? null;
      return {
        url,
        command,
        params,
        supported: description !== null,
        description: description ?? "Unknown command",
      };
    });

    return res.status(200).json({ results, total: results.length });
  });
}
