import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { insertGroupSchema, insertGroupMemberSchema, GROUP_MEMBER_STATUS, GROUP_MEMBER_TYPE } from "@shared/schema";

export function registerGroupRoutes(app: Express): void {

  // ── Groups CRUD ────────────────────────────────────────────────────────────

  // GET /api/groups — list groups
  app.get("/api/groups", async (req: Request, res: Response) => {
    const statusParam = req.query.status !== undefined ? Number(req.query.status) : undefined;
    const allGroups = await storage.getGroups(statusParam);
    return res.status(200).json({ groups: allGroups });
  });

  // GET /api/groups/:id — getGroup(groupId)
  // Java: FusionDbGroupDAOChain.getGroup
  // SQL:  SELECT groups.* FROM groups LEFT JOIN service ... WHERE groups.id=? AND groups.status=1
  app.get("/api/groups/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    const group = await storage.getGroup(id);
    if (!group) return res.status(404).json({ message: "Group tidak ditemukan" });
    return res.status(200).json({ group });
  });

  // POST /api/groups — create group
  app.post("/api/groups", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const parsed = insertGroupSchema.safeParse({ ...req.body, createdBy: req.session.userId });
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });
    const group = await storage.createGroup(parsed.data);
    // Auto-add creator as admin member
    await storage.addGroupMember({ username: req.session.userId, groupId: group.id, type: GROUP_MEMBER_TYPE.ADMIN });
    return res.status(201).json({ group });
  });

  // PUT /api/groups/:id — update group
  app.put("/api/groups/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    const updated = await storage.updateGroup(id, req.body);
    if (!updated) return res.status(404).json({ message: "Group tidak ditemukan" });
    return res.status(200).json({ group: updated });
  });

  // DELETE /api/groups/:id — delete group
  app.delete("/api/groups/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "ID tidak valid" });
    await storage.deleteGroup(id);
    return res.status(200).json({ message: "Group dihapus" });
  });

  // ── Group Members ─────────────────────────────────────────────────────────

  // GET /api/groups/:id/members — getGroupMembers(groupId)
  app.get("/api/groups/:id/members", async (req: Request, res: Response) => {
    const groupId = Number(req.params.id);
    if (isNaN(groupId)) return res.status(400).json({ message: "ID tidak valid" });
    const statusParam = req.query.status !== undefined ? Number(req.query.status) : GROUP_MEMBER_STATUS.ACTIVE;
    const members = await storage.getGroupMembers(groupId, statusParam);
    return res.status(200).json({ members });
  });

  // GET /api/groups/:id/moderators — getModeratorUserNames(groupId)
  // Java: FusionDbGroupDAOChain.getModeratorUserNames
  // SQL:  SELECT gm.username FROM groupmember WHERE groupid=? AND status=ACTIVE AND type=MODERATOR
  app.get("/api/groups/:id/moderators", async (req: Request, res: Response) => {
    const groupId = Number(req.params.id);
    if (isNaN(groupId)) return res.status(400).json({ message: "ID tidak valid" });
    const usernames = await storage.getModeratorUserNames(groupId);
    return res.status(200).json({ usernames });
  });

  // POST /api/groups/:id/members — addGroupMember (join group)
  app.post("/api/groups/:id/members", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const groupId = Number(req.params.id);
    if (isNaN(groupId)) return res.status(400).json({ message: "ID tidak valid" });

    const group = await storage.getGroup(groupId);
    if (!group) return res.status(404).json({ message: "Group tidak ditemukan" });

    const username = (req.body.username as string) ?? req.session.userId;
    const type = Number(req.body.type ?? GROUP_MEMBER_TYPE.MEMBER);

    const parsed = insertGroupMemberSchema.safeParse({ username, groupId, type });
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid", errors: parsed.error.flatten() });

    const member = await storage.addGroupMember(parsed.data);
    return res.status(201).json({ member });
  });

  // PATCH /api/groups/:id/members/:memberId — updateGroupMember (set role, status)
  app.patch("/api/groups/:id/members/:memberId", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const memberId = Number(req.params.memberId);
    if (isNaN(memberId)) return res.status(400).json({ message: "Member ID tidak valid" });
    const updated = await storage.updateGroupMember(memberId, req.body);
    if (!updated) return res.status(404).json({ message: "Member tidak ditemukan" });
    return res.status(200).json({ member: updated });
  });

  // DELETE /api/groups/:id/members/:memberId — removeGroupMember (leave / kick)
  app.delete("/api/groups/:id/members/:memberId", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const memberId = Number(req.params.memberId);
    if (isNaN(memberId)) return res.status(400).json({ message: "Member ID tidak valid" });
    await storage.removeGroupMember(memberId);
    return res.status(200).json({ message: "Member dihapus dari group" });
  });

  // GET /api/groups/user/:username — getGroupMembersByUsername (semua group seorang user)
  app.get("/api/groups/user/:username", async (req: Request, res: Response) => {
    const members = await storage.getGroupMembersByUsername(req.params.username);
    return res.status(200).json({ members });
  });
}
