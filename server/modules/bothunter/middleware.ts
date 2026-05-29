import type { Request, Response, NextFunction } from "express";
import { botHunterEngine } from "./engine";

export function botHunterMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (botHunterEngine.isBannedIP(ip)) {
    return res.status(403).json({ message: "Access denied" });
  }

  const port = req.socket?.remotePort ?? Math.floor(Math.random() * 65535);
  const username = req.session?.userId as string | undefined;

  if (username && botHunterEngine.isBannedUser(username)) {
    return res.status(403).json({ message: "Your account has been suspended" });
  }

  botHunterEngine.recordRequest(ip, port, username);

  next();
}
