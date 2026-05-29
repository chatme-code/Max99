import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertGuardsetRuleSchema, CLIENT_TYPE, GUARD_CAPABILITY } from "@shared/schema";
import { z } from "zod";

// Mirrors GuardsetDAO.java:
//   getMinimumClientVersionForAccess(clientType, guardCapability)
//   — maps to guardcapability / guardsetcapability / guardsetmember / clientversion tables
//   Simplified into single guardset_rules table:
//     SELECT minVersion FROM guardset_rules WHERE clientType = ? AND guardCapability = ?
//   Returns null if no rule found (feature is open to all versions)
//   Returns Short.MAX_VALUE (32767) if capability is protected but version not set

const setGuardsetSchema = z.object({
  clientType: z.number().int().min(1),
  guardCapability: z.number().int().min(1),
  minVersion: z.number().int().min(0).max(32767),
  description: z.string().optional(),
});

export function registerGuardsetRoutes(app: Express): void {

  // GET /api/guardset/rules — list all guardset rules
  app.get("/api/guardset/rules", async (_req: Request, res: Response) => {
    const rules = await storage.getGuardsetRules();
    return res.status(200).json({ rules });
  });

  // GET /api/guardset/check — getMinimumClientVersionForAccess(clientType, guardCapability)
  // Mirrors FusionDbGuardsetDAOChain.getMinimumClientVersionForAccess
  // Usage: GET /api/guardset/check?clientType=1&guardCapability=2&clientVersion=100
  app.get("/api/guardset/check", async (req: Request, res: Response) => {
    const clientType = parseInt(req.query.clientType as string, 10);
    const guardCapability = parseInt(req.query.guardCapability as string, 10);
    const clientVersion = req.query.clientVersion ? parseInt(req.query.clientVersion as string, 10) : null;

    if (isNaN(clientType) || isNaN(guardCapability)) {
      return res.status(400).json({ message: "clientType dan guardCapability wajib diisi" });
    }

    const minVersion = await storage.getMinimumClientVersionForAccess(clientType, guardCapability);

    // Mirrors FusionDbGuardsetDAOChain: returns null if no restriction, SHORT.MAX_VALUE if blocked
    if (minVersion === null) {
      return res.status(200).json({ allowed: true, minVersion: null, message: "No version restriction" });
    }

    if (clientVersion !== null && !isNaN(clientVersion)) {
      const allowed = clientVersion >= minVersion;
      return res.status(200).json({
        allowed,
        minVersion,
        clientVersion,
        message: allowed
          ? "Client version meets requirement"
          : `Minimum client version required: ${minVersion}`,
      });
    }

    return res.status(200).json({ minVersion });
  });

  // GET /api/guardset/constants — expose CLIENT_TYPE and GUARD_CAPABILITY enums to clients
  app.get("/api/guardset/constants", (_req: Request, res: Response) => {
    return res.status(200).json({ clientTypes: CLIENT_TYPE, guardCapabilities: GUARD_CAPABILITY });
  });

  // POST /api/guardset/rules — setGuardsetRule (admin only)
  // Mirrors: INSERT/UPDATE guardset_rules SET minVersion WHERE clientType = ? AND guardCapability = ?
  app.post("/api/guardset/rules", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const parsed = setGuardsetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    const { clientType, guardCapability, minVersion, description } = parsed.data;
    const rule = await storage.setGuardsetRule(clientType, guardCapability, minVersion, description);
    return res.status(200).json({ rule });
  });

  // DELETE /api/guardset/rules/:id — deleteGuardsetRule (admin only)
  app.delete("/api/guardset/rules/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid rule ID" });
    await storage.deleteGuardsetRule(id);
    return res.status(200).json({ message: "Guardset rule deleted" });
  });
}
