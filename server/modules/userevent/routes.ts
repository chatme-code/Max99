import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { USER_EVENT_TYPE } from "@shared/schema";
import type { UserEvent } from "@shared/schema";

// ─── MIRRORS com/projectgoth/fusion/userevent/ ────────────────────────────────
// CreateEventForUser.java    → POST /api/userevent, POST /api/userevent/group-post
// DeleteEventsForUser.java   → DELETE /api/userevent/:username[/:eventType]
// DumpEvents.java            → GET /api/userevent/:username
// DumpGeneratorEvents.java   → GET /api/userevent/generator
// DumpTranslateGeneratorEvents.java → GET /api/userevent/generator/translated
// ShowEventsForUser.java     → GET /api/userevent/:username (with ?translate=1)
// ShowEventsGeneratedByUser.java → GET /api/userevent/generated/:username
// ShowPrivacySettings.java   → GET /api/userevent/privacy/:username
// ModifyPrivacySettings.java → PUT /api/userevent/privacy/:username
// EventTextTranslator.java   → translateEvent() helper
// domain/UserEventType.java  → USER_EVENT_TYPE enum (15 types, byte value map)
// domain/EventPrivacySetting.java → applyPrivacyMask() helper

// ─── EventTextTranslator.java mirror ─────────────────────────────────────────
// Client type constants (mirrors Java ClientType enum → getTemplateName logic)
// MIDP2/MIDP1 → "kb", ANDROID → "touch", AJAX2 → "ajaxv2", others → as-is
const CLIENT_TYPE_KB = "kb";
const CLIENT_TYPE_TOUCH = "touch";
const CLIENT_TYPE_AJAXV2 = "ajaxv2";

function getClientTypeName(clientType: string): string {
  const t = clientType.toUpperCase();
  if (t === "MIDP2" || t === "MIDP1") return CLIENT_TYPE_KB;
  if (t === "ANDROID") return CLIENT_TYPE_TOUCH;
  if (t === "AJAX2") return CLIENT_TYPE_AJAXV2;
  return clientType.toLowerCase();
}

// Mirrors EventTextTranslator.getTemplateName(eventName, deviceType)
function getTemplateName(eventName: string, clientType: string): string {
  return `${getClientTypeName(clientType)}-${eventName}`;
}

// Mirrors EventTextTranslator.invokeRelevantTranslator — produces human-readable
// text for each event type based on payload and clientType.
// Since we don't use a translation.properties file, the template is built inline.
function translateEvent(event: UserEvent, clientType: string, receivingUsername?: string): string {
  const p = (event.payload as Record<string, any>) ?? {};
  const gen = event.generatingUsername ?? p.generatingUsername ?? "?";
  const templateName = getTemplateName(event.eventType, clientType);

  switch (event.eventType) {
    case USER_EVENT_TYPE.ADDING_FRIEND:
      return `[${templateName}] ${gen} added ${p.friendUsername ?? "a friend"}`;
    case USER_EVENT_TYPE.SHORT_TEXT_STATUS:
      return `[${templateName}] ${gen}: ${p.status ?? ""}`;
    case USER_EVENT_TYPE.UPDATING_PROFILE:
    case USER_EVENT_TYPE.PROFILE_UPDATED:
      return `[${templateName}] ${gen} updated their profile`;
    case USER_EVENT_TYPE.PHOTO_UPLOAD_WITH_TITLE:
      return `[${templateName}] ${gen} uploaded photo: ${p.title ?? ""}`;
    case USER_EVENT_TYPE.PHOTO_UPLOAD_WITHOUT_TITLE:
      return `[${templateName}] ${gen} uploaded a photo`;
    case USER_EVENT_TYPE.CREATE_PUBLIC_CHATROOM:
      return `[${templateName}] ${gen} created chatroom ${p.chatroomName ?? ""}`;
    case USER_EVENT_TYPE.PURCHASED_GOODS:
      return `[${templateName}] ${gen} purchased ${p.itemType ?? "virtual goods"}`;
    case USER_EVENT_TYPE.VIRTUAL_GIFT:
      return `[${templateName}] ${gen} sent a ${p.giftName ?? "gift"} to ${p.recipient ?? "?"}`;
    case USER_EVENT_TYPE.GROUP_DONATION:
      return `[${templateName}] ${gen} donated to group ${p.groupId ?? ""}`;
    case USER_EVENT_TYPE.GROUP_JOINED:
      return `[${templateName}] ${gen} joined group ${p.groupName ?? ""}`;
    case USER_EVENT_TYPE.GROUP_ANNOUNCEMENT:
      return `[${templateName}] ${gen} posted announcement in group ${p.groupId ?? ""}`;
    case USER_EVENT_TYPE.GROUP_USER_POST:
    case USER_EVENT_TYPE.MADEGROUP_USER_POST: {
      const topicText = p.topicText ?? p.topicId ?? "";
      return `[${templateName}] ${gen} posted in group topic ${topicText}`;
    }
    case USER_EVENT_TYPE.USER_WALL_POST: {
      const wallOwner = p.wallOwnerUsername ?? "?";
      if (receivingUsername && wallOwner === receivingUsername) {
        return `[${templateName}_YOUR] ${gen} posted on your wall`;
      }
      if (gen === wallOwner) {
        return `[${templateName}_THEIR] ${gen} posted on their own wall`;
      }
      return `[${templateName}] ${gen} posted on ${wallOwner}'s wall`;
    }
    case USER_EVENT_TYPE.GENERIC_APP_EVENT:
      return `[${templateName}] ${gen}: ${p.appName ?? "app"} - ${p.description ?? ""}`;
    case USER_EVENT_TYPE.GIFT_SHOWER_EVENT:
      return `[${templateName}] ${gen} gift showered ${p.recipient ?? "?"}`;
    default:
      return `[${templateName}] ${gen} - ${event.eventType}`;
  }
}

// ─── EventPrivacySetting.java mirror ─────────────────────────────────────────
// Maps event type to the relevant receiving-mask boolean field name.
// Returns true if the event passes the mask (should be shown), false if filtered.
function applyPrivacyMask(eventType: string, mask: Record<string, boolean>): boolean {
  switch (eventType) {
    case USER_EVENT_TYPE.ADDING_FRIEND:
      return mask.receivingAddFriends ?? false;
    case USER_EVENT_TYPE.PURCHASED_GOODS:
      return mask.receivingContentPurchased ?? true;
    case USER_EVENT_TYPE.SHORT_TEXT_STATUS:
      return mask.receivingStatusUpdates ?? true;
    case USER_EVENT_TYPE.UPDATING_PROFILE:
    case USER_EVENT_TYPE.PROFILE_UPDATED:
      return mask.receivingProfileChanges ?? true;
    case USER_EVENT_TYPE.PHOTO_UPLOAD_WITH_TITLE:
    case USER_EVENT_TYPE.PHOTO_UPLOAD_WITHOUT_TITLE:
      return mask.receivingPhotosPublished ?? true;
    case USER_EVENT_TYPE.CREATE_PUBLIC_CHATROOM:
      return mask.receivingChatroomCreation ?? true;
    case USER_EVENT_TYPE.VIRTUAL_GIFT:
      return mask.receivingVirtualGifting ?? true;
    // UserWallPost, GroupUserEvent, GenericApp, GiftShower → always true
    case USER_EVENT_TYPE.USER_WALL_POST:
    case USER_EVENT_TYPE.GROUP_JOINED:
    case USER_EVENT_TYPE.GROUP_ANNOUNCEMENT:
    case USER_EVENT_TYPE.GROUP_DONATION:
    case USER_EVENT_TYPE.GROUP_USER_POST:
    case USER_EVENT_TYPE.MADEGROUP_USER_POST:
    case USER_EVENT_TYPE.GENERIC_APP_EVENT:
    case USER_EVENT_TYPE.GIFT_SHOWER_EVENT:
      return true;
    default:
      return false;
  }
}

// ─── UserEventType byte-value map (mirrors domain/UserEventType.java) ─────────
const USER_EVENT_TYPE_VALUE: Record<string, number> = {
  [USER_EVENT_TYPE.SHORT_TEXT_STATUS]:        1,
  [USER_EVENT_TYPE.PHOTO_UPLOAD_WITH_TITLE]:  2,
  [USER_EVENT_TYPE.PHOTO_UPLOAD_WITHOUT_TITLE]: 3,
  [USER_EVENT_TYPE.CREATE_PUBLIC_CHATROOM]:   4,
  [USER_EVENT_TYPE.ADDING_FRIEND]:            5,
  [USER_EVENT_TYPE.UPDATING_PROFILE]:         6,
  [USER_EVENT_TYPE.PURCHASED_GOODS]:          7,
  [USER_EVENT_TYPE.VIRTUAL_GIFT]:             8,
  [USER_EVENT_TYPE.GROUP_DONATION]:           9,
  [USER_EVENT_TYPE.GROUP_JOINED]:             10,
  [USER_EVENT_TYPE.GROUP_ANNOUNCEMENT]:       11,
  [USER_EVENT_TYPE.GROUP_USER_POST]:          12,
  [USER_EVENT_TYPE.USER_WALL_POST]:           13,
  [USER_EVENT_TYPE.GENERIC_APP_EVENT]:        14,
  [USER_EVENT_TYPE.GIFT_SHOWER_EVENT]:        15,
};

export function registerUserEventRoutes(app: Express) {

  // ── GET /api/userevent/types ─────────────────────────────────────────────────
  // List all valid event types with their byte values
  // Mirrors domain/UserEventType.java enum values()
  app.get("/api/userevent/types", (_req, res) => {
    const types = Object.values(USER_EVENT_TYPE).map(t => ({
      name: t,
      value: USER_EVENT_TYPE_VALUE[t] ?? null,
    }));
    res.json({ eventTypes: types });
  });

  // ── GET /api/userevent/generator ──────────────────────────────────────────────
  // Dump most recent N generator events
  // Mirrors DumpGeneratorEvents.java: dump(requestedCount)
  // Query: ?count=50
  app.get("/api/userevent/generator", async (req, res) => {
    const count = Math.min(parseInt(req.query.count as string) || 50, 500);
    try {
      const events = await storage.getGeneratorEvents(count);
      res.json({ count: events.length, events });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/userevent/generator/translated ───────────────────────────────────
  // Dump generator events with translation, filtered to last 2 weeks
  // Mirrors DumpTranslateGeneratorEvents.java: dump()
  // Query: ?clientType=MIDP2&count=50
  app.get("/api/userevent/generator/translated", async (req, res) => {
    const count = Math.min(parseInt(req.query.count as string) || 50, 500);
    const clientType = (req.query.clientType as string) || "MIDP2";
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    try {
      const events = await storage.getGeneratorEvents(count * 5);
      const translated = events
        .filter(e => new Date(e.createdAt) >= twoWeeksAgo)
        .slice(0, count)
        .map(e => ({
          ...e,
          translatedText: translateEvent(e, clientType),
        }));
      res.json({ count: translated.length, clientType, events: translated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/userevent/stats/:username ────────────────────────────────────────
  // Get event counts grouped by type for a user
  app.get("/api/userevent/stats/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const stats = await storage.getUserEventStats(username);
      res.json({ username, stats });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/userevent/generated/:username ────────────────────────────────────
  // Get events generated/sent by a user (mirrors ShowEventsGeneratedByUser.java)
  // Java: eventSystemPrx.getUserEventsGeneratedByUser(username)
  // Query: ?limit=50&eventType=GROUP_USER_POST&since=2024-01-01T00:00:00Z&translate=1&clientType=MIDP2
  app.get("/api/userevent/generated/:username", async (req, res) => {
    const { username } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const eventType = req.query.eventType as string | undefined;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const translate = req.query.translate === "1" || req.query.translate === "true";
    const clientType = (req.query.clientType as string) || "MIDP2";
    try {
      const events = await storage.getUserEventsGeneratedByUser(username, limit, eventType, since);
      if (translate) {
        const translated = events.map(e => ({
          ...e,
          generatingUsername: e.generatingUsername ?? username,
          generatingUserDisplayPicture: (e.payload as any)?.generatingUserDisplayPicture,
          translatedText: translateEvent(e, clientType, username),
        }));
        return res.json({ username, events: translated, count: translated.length });
      }
      res.json({ username, events, count: events.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/userevent/privacy/:username ──────────────────────────────────────
  // Show receiving and publishing privacy masks for a user
  // Mirrors ShowPrivacySettings.java:
  //   EventPrivacySetting receivingMask = getReceivingPrivacyMask(username)
  //   EventPrivacySetting publishingMask = getPublishingPrivacyMask(username)
  app.get("/api/userevent/privacy/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const settings = await storage.getPrivacySettings(username);
      const receivingMask = {
        statusUpdates:     settings.receivingStatusUpdates,
        profileChanges:    settings.receivingProfileChanges,
        addFriends:        settings.receivingAddFriends,
        photosPublished:   settings.receivingPhotosPublished,
        contentPurchased:  settings.receivingContentPurchased,
        chatroomCreation:  settings.receivingChatroomCreation,
        virtualGifting:    settings.receivingVirtualGifting,
      };
      const publishingMask = {
        statusUpdates:     settings.publishingStatusUpdates,
        profileChanges:    settings.publishingProfileChanges,
        addFriends:        settings.publishingAddFriends,
        photosPublished:   settings.publishingPhotosPublished,
        contentPurchased:  settings.publishingContentPurchased,
        chatroomCreation:  settings.publishingChatroomCreation,
        virtualGifting:    settings.publishingVirtualGifting,
      };
      res.json({ username, receivingMask, publishingMask });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PUT /api/userevent/privacy/:username ──────────────────────────────────────
  // Modify receiving and/or publishing privacy masks for a user
  // Mirrors ModifyPrivacySettings.java:
  //   eventSystem.setReceivingPrivacyMask(username, mask)
  //   eventSystem.setPublishingPrivacyMask(username, mask)
  // Body: {
  //   receiving?: { statusUpdates?, profileChanges?, addFriends?, photosPublished?,
  //                 contentPurchased?, chatroomCreation?, virtualGifting? },
  //   publishing?: { ... same fields ... }
  // }
  app.put("/api/userevent/privacy/:username", async (req, res) => {
    const { username } = req.params;
    const maskFieldSchema = z.object({
      statusUpdates:    z.boolean().optional(),
      profileChanges:   z.boolean().optional(),
      addFriends:       z.boolean().optional(),
      photosPublished:  z.boolean().optional(),
      contentPurchased: z.boolean().optional(),
      chatroomCreation: z.boolean().optional(),
      virtualGifting:   z.boolean().optional(),
    });
    const schema = z.object({
      receiving:  maskFieldSchema.optional(),
      publishing: maskFieldSchema.optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      let settings = await storage.getPrivacySettings(username);
      if (parsed.data.receiving) {
        settings = await storage.setReceivingPrivacyMask(username, parsed.data.receiving);
      }
      if (parsed.data.publishing) {
        settings = await storage.setPublishingPrivacyMask(username, parsed.data.publishing);
      }
      const receivingMask = {
        statusUpdates:     settings.receivingStatusUpdates,
        profileChanges:    settings.receivingProfileChanges,
        addFriends:        settings.receivingAddFriends,
        photosPublished:   settings.receivingPhotosPublished,
        contentPurchased:  settings.receivingContentPurchased,
        chatroomCreation:  settings.receivingChatroomCreation,
        virtualGifting:    settings.receivingVirtualGifting,
      };
      const publishingMask = {
        statusUpdates:     settings.publishingStatusUpdates,
        profileChanges:    settings.publishingProfileChanges,
        addFriends:        settings.publishingAddFriends,
        photosPublished:   settings.publishingPhotosPublished,
        contentPurchased:  settings.publishingContentPurchased,
        chatroomCreation:  settings.publishingChatroomCreation,
        virtualGifting:    settings.publishingVirtualGifting,
      };
      res.json({ success: true, username, receivingMask, publishingMask });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/userevent/group-post ────────────────────────────────────────────
  // Create a GROUP_USER_POST event for a user
  // Mirrors CreateEventForUser.java: eventSystemPrx.madeGroupUserPost(username, topicId, postId)
  // Body: { username, topicId, postId, generatingUsername? }
  app.post("/api/userevent/group-post", async (req, res) => {
    const schema = z.object({
      username:           z.string().min(1),
      topicId:            z.number().int(),
      postId:             z.number().int(),
      generatingUsername: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, topicId, postId, generatingUsername } = parsed.data;
    try {
      const event = await storage.createUserEvent({
        username,
        generatingUsername: generatingUsername ?? username,
        eventType: USER_EVENT_TYPE.MADEGROUP_USER_POST,
        payload: { topicId, postId },
      });
      res.status(201).json({ success: true, event });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/userevent ──────────────────────────────────────────────────────
  // Create a user event (generic, mirrors EventSystemPrx.madeGroupUserPost() etc.)
  // Body: { username, eventType, payload?, generatingUsername? }
  app.post("/api/userevent", async (req, res) => {
    const schema = z.object({
      username:           z.string().min(1),
      generatingUsername: z.string().optional(),
      eventType:          z.string().min(1),
      payload:            z.record(z.any()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, generatingUsername, eventType, payload } = parsed.data;
    try {
      const event = await storage.createUserEvent({
        username,
        generatingUsername: generatingUsername ?? null,
        eventType,
        payload: payload ?? null,
      });
      res.status(201).json({ success: true, event });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/userevent/batch ────────────────────────────────────────────────
  // Create multiple user events in one call
  // Body: { events: [{ username, eventType, payload?, generatingUsername? }] }
  app.post("/api/userevent/batch", async (req, res) => {
    const schema = z.object({
      events: z.array(z.object({
        username:           z.string().min(1),
        generatingUsername: z.string().optional(),
        eventType:          z.string().min(1),
        payload:            z.record(z.any()).optional(),
      })).min(1).max(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const created = await Promise.all(
        parsed.data.events.map(e =>
          storage.createUserEvent({
            username: e.username,
            generatingUsername: e.generatingUsername ?? null,
            eventType: e.eventType,
            payload: e.payload ?? null,
          })
        )
      );
      res.status(201).json({ success: true, created: created.length, events: created });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/userevent/:username ─────────────────────────────────────────────
  // Get events for a user (mirrors ShowEventsForUser.java / DumpEvents.java)
  // Java: eventSystem.getUserEventsForUser(username) — iterates and prints each event
  // Query: ?limit=50&eventType=LOGIN&since=2024-01-01T00:00:00Z
  //        &translate=1&clientType=MIDP2
  //        &applyMask=1  (apply receiving privacy mask filtering)
  app.get("/api/userevent/:username", async (req, res) => {
    const { username } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const eventType = req.query.eventType as string | undefined;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const translate = req.query.translate === "1" || req.query.translate === "true";
    const clientType = (req.query.clientType as string) || "MIDP2";
    const applyMask = req.query.applyMask === "1" || req.query.applyMask === "true";

    try {
      let events = await storage.getUserEvents(username, limit, eventType, since);

      // Apply receiving privacy mask (mirrors EventPrivacySetting.applyMask)
      if (applyMask) {
        const settings = await storage.getPrivacySettings(username);
        events = events.filter(e =>
          applyPrivacyMask(e.eventType, settings as unknown as Record<string, boolean>)
        );
      }

      if (translate) {
        // Mirrors ShowEventsForUser.printEvent(event, receivingUsername)
        const translated = events.map(e => ({
          ...e,
          generatingUsername: e.generatingUsername,
          generatingUserDisplayPicture: (e.payload as any)?.generatingUserDisplayPicture,
          status: (e.payload as any)?.status,
          topicText: (e.payload as any)?.topicText,
          translatedText: translateEvent(e, clientType, username),
        }));
        return res.json({ username, events: translated, count: translated.length });
      }

      res.json({ username, events, count: events.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/userevent/:username ─────────────────────────────────────────
  // Delete all events for a user (mirrors DeleteEventsForUser.java)
  // Java: eventSystem.deleteUserEvents(username)
  app.delete("/api/userevent/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const count = await storage.deleteUserEvents(username);
      res.json({ success: true, deleted: count, username });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/userevent/:username/:eventType ───────────────────────────────
  // Delete specific event type for a user
  app.delete("/api/userevent/:username/:eventType", async (req, res) => {
    const { username, eventType } = req.params;
    try {
      const count = await storage.deleteUserEventsByType(username, eventType);
      res.json({ success: true, deleted: count, username, eventType });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
