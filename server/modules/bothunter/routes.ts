import type { Express, Request, Response } from "express";
import { botHunterEngine } from "./engine";

export function registerBotHunterRoutes(app: Express): void {

  app.get("/api/bothunter/suspects", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const suspects = botHunterEngine.getLatestSuspects();
    return res.status(200).json({ suspects });
  });

  app.get("/api/bothunter/stats", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const stats = botHunterEngine.getStats();
    return res.status(200).json({ stats });
  });

  app.get("/api/bothunter/config", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const config = botHunterEngine.getConfig();
    return res.status(200).json({ config });
  });

  app.patch("/api/bothunter/config", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    botHunterEngine.updateConfig(req.body);
    return res.status(200).json({ config: botHunterEngine.getConfig() });
  });

  app.get("/api/bothunter/banned/ips", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const ips = botHunterEngine.getBannedIPs();
    return res.status(200).json({ bannedIPs: ips });
  });

  app.post("/api/bothunter/banned/ips", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const { ip } = req.body;
    if (!ip || typeof ip !== "string") return res.status(400).json({ message: "Invalid IP address" });
    botHunterEngine.banIP(ip);
    return res.status(200).json({ message: `IP ${ip} banned` });
  });

  app.delete("/api/bothunter/banned/ips/:ip", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const ip = decodeURIComponent(req.params.ip);
    const removed = botHunterEngine.unbanIP(ip);
    if (!removed) return res.status(404).json({ message: "IP not found in ban list" });
    return res.status(200).json({ message: `IP ${ip} unbanned` });
  });

  app.get("/api/bothunter/banned/users", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const users = botHunterEngine.getBannedUsers();
    return res.status(200).json({ bannedUsers: users });
  });

  app.post("/api/bothunter/banned/users", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const { username } = req.body;
    if (!username || typeof username !== "string") return res.status(400).json({ message: "Invalid username" });
    botHunterEngine.banUser(username);
    return res.status(200).json({ message: `User ${username} banned` });
  });

  app.delete("/api/bothunter/banned/users/:username", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const username = decodeURIComponent(req.params.username);
    const removed = botHunterEngine.unbanUser(username);
    if (!removed) return res.status(404).json({ message: "User not found in ban list" });
    return res.status(200).json({ message: `User ${username} unbanned` });
  });

  app.post("/api/bothunter/report-invalid", async (req: Request, res: Response) => {
    const { ip, port, userCount } = req.body;
    if (!ip || typeof ip !== "string") return res.status(400).json({ message: "Invalid IP" });
    botHunterEngine.recordInvalidPacket(ip, port ?? 0, userCount ?? 0);
    return res.status(200).json({ message: "Invalid packet recorded" });
  });
}
