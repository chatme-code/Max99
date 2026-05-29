import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { USER_SETTING_TYPE } from "@shared/schema";

// Privacy settings API
// Mirrors: com/projectgoth/fusion/restapi/resource/SettingsResource.java
//          SettingsProfileDetailsData + SettingsAccountCommunicationData + EventPrivacySetting

const updatePrivacySchema = z.object({
  // Profile Details - SettingsProfileDetailsData
  dobPrivacy: z.number().int().min(0).max(2).optional(),           // 0=HIDE 1=SHOW_FULL 2=SHOW_WITHOUT_YEAR (DobPrivacy)
  firstLastNamePrivacy: z.number().int().min(0).max(1).optional(), // 0=HIDE 1=SHOW (FLNamePv)
  mobilePhonePrivacy: z.number().int().min(0).max(2).optional(),   // 0=HIDE 1=EVERYONE 2=FRIEND_ONLY (MobNumPrivacy)
  externalEmailPrivacy: z.number().int().min(0).max(3).optional(), // 0=HIDE 1=EVERYONE 2=FRIEND_ONLY 3=FOLLOWER_ONLY (ExtEmPv)
  // Account Communication - SettingsAccountCommunicationData
  chatPrivacy: z.number().int().min(1).max(3).optional(),          // 1=EVERYONE 2=FRIEND_ONLY 3=FOLLOWER_ONLY (ChatPv)
  buzzPrivacy: z.number().int().min(0).max(1).optional(),          // 1=ON 0=OFF (BuzzPv)
  lookoutPrivacy: z.number().int().min(0).max(1).optional(),       // 1=ON 0=OFF (LOPv)
  footprintsPrivacy: z.number().int().min(0).max(3).optional(),    // 0=HIDE 1=EVERYONE 2=FRIEND_ONLY 3=FOLLOWER_ONLY (FPPv)
  feedPrivacy: z.number().int().min(1).max(2).optional(),          // 1=EVERYONE 2=FRIEND_OR_FOLLOWER (FeedPv)
  // Activity/Event - EventPrivacySetting
  activityStatusUpdates: z.boolean().optional(),
  activityProfileChanges: z.boolean().optional(),
  activityAddFriends: z.boolean().optional(),
  activityPhotosPublished: z.boolean().optional(),
  activityContentPurchased: z.boolean().optional(),
  activityChatroomCreation: z.boolean().optional(),
  activityVirtualGifting: z.boolean().optional(),
});

export function registerSettingsRoutes(app: Express) {

  // ── GET /api/settings/privacy/:username ────────────────────────────────────
  // Get full privacy settings for a user
  // Mirrors: SettingsResource#getAccountCommunicationPrivacy + getProfileDetailsPrivacy
  app.get("/api/settings/privacy/:username", async (req, res) => {
    try {
      const settings = await storage.getUserPrivacySettings(req.params.username);
      res.json(settings);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUT /api/settings/privacy/:username ────────────────────────────────────
  // Update privacy settings for a user (partial update supported)
  // Mirrors: SettingsResource#updateAccountCommunicationPrivacy + updateProfileDetailsPrivacy
  app.put("/api/settings/privacy/:username", async (req, res) => {
    const parsed = updatePrivacySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }
    try {
      const updated = await storage.updateUserPrivacySettings(req.params.username, parsed.data);
      res.json({ success: true, settings: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/settings/notifications/:username ─────────────────────────────
  // Returns notification settings for a user mapped from user_settings table.
  // Mirrors: SettingsResource user setting endpoints
  // UserSettingData.TypeEnum: MESSAGE=2, EMAIL_MENTION=4, EMAIL_REPLY_TO_POST=5,
  //   EMAIL_RECEIVE_GIFT=6, EMAIL_NEW_FOLLOWER=7
  app.get("/api/settings/notifications/:username", async (req, res) => {
    try {
      const { username } = req.params;
      const rows = await storage.getUserSettings(username);
      const rowMap: Record<number, number> = {};
      for (const r of rows) rowMap[r.type] = r.value;

      // Defaults mirror Java: MESSAGE default = FRIENDS_ONLY (2), emails default = DISABLED (0)
      const settings = {
        messageSetting:   rowMap[USER_SETTING_TYPE.MESSAGE]             ?? 2,
        emailMention:     (rowMap[USER_SETTING_TYPE.EMAIL_MENTION]      ?? 0) === 1,
        emailReplyToPost: (rowMap[USER_SETTING_TYPE.EMAIL_REPLY_TO_POST]?? 0) === 1,
        emailReceiveGift: (rowMap[USER_SETTING_TYPE.EMAIL_RECEIVE_GIFT] ?? 0) === 1,
        emailNewFollower: (rowMap[USER_SETTING_TYPE.EMAIL_NEW_FOLLOWER] ?? 0) === 1,
      };
      res.json(settings);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUT /api/settings/notifications/:username ─────────────────────────────
  // Updates one or more notification settings for a user.
  // Mirrors: SettingsResource#updateUserSettings + setEmailNotification
  const updateNotifSchema = z.object({
    messageSetting:   z.number().int().min(0).max(2).optional(), // 0=DISABLED 1=EVERYONE 2=FRIENDS_ONLY
    emailMention:     z.boolean().optional(),
    emailReplyToPost: z.boolean().optional(),
    emailReceiveGift: z.boolean().optional(),
    emailNewFollower: z.boolean().optional(),
  });

  app.put("/api/settings/notifications/:username", async (req, res) => {
    const parsed = updateNotifSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }
    try {
      const { username } = req.params;
      const { messageSetting, emailMention, emailReplyToPost, emailReceiveGift, emailNewFollower } = parsed.data;

      if (messageSetting !== undefined) {
        await storage.upsertUserSetting(username, USER_SETTING_TYPE.MESSAGE, messageSetting);
      }
      if (emailMention !== undefined) {
        await storage.upsertUserSetting(username, USER_SETTING_TYPE.EMAIL_MENTION, emailMention ? 1 : 0);
      }
      if (emailReplyToPost !== undefined) {
        await storage.upsertUserSetting(username, USER_SETTING_TYPE.EMAIL_REPLY_TO_POST, emailReplyToPost ? 1 : 0);
      }
      if (emailReceiveGift !== undefined) {
        await storage.upsertUserSetting(username, USER_SETTING_TYPE.EMAIL_RECEIVE_GIFT, emailReceiveGift ? 1 : 0);
      }
      if (emailNewFollower !== undefined) {
        await storage.upsertUserSetting(username, USER_SETTING_TYPE.EMAIL_NEW_FOLLOWER, emailNewFollower ? 1 : 0);
      }

      // Return fresh settings
      const rows = await storage.getUserSettings(username);
      const rowMap: Record<number, number> = {};
      for (const r of rows) rowMap[r.type] = r.value;

      const settings = {
        messageSetting:   rowMap[USER_SETTING_TYPE.MESSAGE]              ?? 2,
        emailMention:     (rowMap[USER_SETTING_TYPE.EMAIL_MENTION]       ?? 0) === 1,
        emailReplyToPost: (rowMap[USER_SETTING_TYPE.EMAIL_REPLY_TO_POST] ?? 0) === 1,
        emailReceiveGift: (rowMap[USER_SETTING_TYPE.EMAIL_RECEIVE_GIFT]  ?? 0) === 1,
        emailNewFollower: (rowMap[USER_SETTING_TYPE.EMAIL_NEW_FOLLOWER]  ?? 0) === 1,
      };
      res.json({ success: true, settings });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
