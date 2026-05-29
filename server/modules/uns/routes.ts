import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { NOTIFICATION_TYPE, NOTIFICATION_STATUS } from "@shared/schema";

// Mirrors com/projectgoth/fusion/uns/ (User Notification Service)
// Note.java: base class with text, created, UUID ID
// AlertNote.java: extends Note → targets Set<users>, hasRecipients()
// SMSNote.java: extends Note → phoneNumber, username, subType (SystemSMSData.SubTypeEnum)
// EmailNote.java: extends Note → sender, senderPassword, recipients Set<String>, subject, mimeType
// EmailGroupTask.java: iterates group members in blocks of 100, adds EmailNote per block
// SMSGroupTask.java: validates smsSubType >= 1, adds SMSNote per member
// AlertGroupTask.java: iterates group members in blocks of 100, adds AlertNote per block
// UserNotificationServiceI.java: main service with all notification dispatch methods
// UserNotificationPurger.java: trims notifications if over MAX limit

// ── Constants (mirrors UserNotificationServiceI field defaults) ────────────────
const DEFAULT_MIG_EMAIL_DOMAIN = "@mig.me";
const GROUP_EMAIL_BLOCK_SIZE = 100;
const ALERT_BLOCK_SIZE = 100;
// SystemSMSData.SubTypeEnum values used by group SMS methods
const SMS_SUBTYPE_GROUP_ANNOUNCEMENT = 1;
const SMS_SUBTYPE_GROUP_EVENT = 2;
// UserNotificationPurger: max notifications before trim, and truncation target
const MAX_NOTIFICATIONS = 500;
const NOTIFICATION_TRUNCATION_TARGET = 400;
// Max notification queue size before drops (mirrors MAX_NOTIFICATION_SERVICE_QUEUE_SIZE)
const MAX_NOTIFICATION_QUEUE_SIZE = 1000;

// ── Module-level stat counters (mirrors AtomicLong fields in UserNotificationServiceI) ──
// These are reset on server restart, mirroring Java behaviour (no persistence).
let emailsSent = 0;
let smsSent = 0;
let alertsSent = 0;
let notificationsSent = 0;
let notificationQueueSize = 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

// Mirrors addEmailNoteIntoQueue: removes bounce emails, removes internal addresses
// unless INTERNAL_EMAIL_ENABLED, then adds to email queue.
// In TS: we store each recipient as a separate notification row.
async function enqueueEmail(recipients: string[], subject: string, message: string, sender?: string): Promise<number> {
  let count = 0;
  for (const recipient of recipients) {
    await storage.createNotification({
      username: recipient,
      type: NOTIFICATION_TYPE.EMAIL,
      subject: sender ? `SENDER:${sender}|${subject}` : subject,
      message,
      status: NOTIFICATION_STATUS.PENDING,
    });
    emailsSent++;
    count++;
  }
  return count;
}

// Mirrors SMSQueueWorkerThread: creates SMS notification row
async function enqueueSMS(username: string, phoneNumber: string, message: string, subType: number): Promise<void> {
  await storage.createNotification({
    username,
    type: NOTIFICATION_TYPE.SMS,
    subject: String(subType),
    message: `${phoneNumber}|${message}`,
    status: NOTIFICATION_STATUS.PENDING,
  });
  smsSent++;
}

// Mirrors AlertQueueWorkerThread: creates alert notification rows
async function enqueueAlert(usernames: string[], message: string): Promise<number> {
  let count = 0;
  for (const username of usernames) {
    await storage.createNotification({
      username,
      type: NOTIFICATION_TYPE.ALERT,
      subject: null,
      message,
      status: NOTIFICATION_STATUS.PENDING,
    });
    alertsSent++;
    count++;
  }
  return count;
}

export function registerUnsRoutes(app: Express) {

  // ── POST /api/uns/notify ───────────────────────────────────────────────────
  // Mirrors UserNotificationServiceI.notifyFusionUser(Message msg)
  // Validates key, toUserId (>= 0), toUsername, notificationType (>= 0).
  // Checks queue capacity before accepting; drops if over MAX_NOTIFICATION_QUEUE_SIZE.
  // Body: { key, toUserId, toUsername, notificationType, parameters? }
  app.post("/api/uns/notify", async (req, res) => {
    const schema = z.object({
      key: z.string().min(1, "key is required"),
      toUserId: z.number().int().min(0, "Invalid userId provided"),
      toUsername: z.string().min(1, "toUsername is required"),
      notificationType: z.number().int().min(0, "Invalid notification type"),
      parameters: z.record(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { key, toUserId, toUsername, notificationType, parameters } = parsed.data;

    if (notificationQueueSize >= MAX_NOTIFICATION_QUEUE_SIZE) {
      console.warn(`NotificationServiceMaxQueueSize[${MAX_NOTIFICATION_QUEUE_SIZE}] exceeded. Dropping message type [${notificationType}] for user [${toUsername}]`);
      return res.status(429).json({ error: "Notification queue full, message dropped" });
    }

    notificationQueueSize++;
    try {
      const notification = await storage.createNotification({
        username: toUsername,
        type: String(notificationType),
        subject: key,
        message: parameters ? JSON.stringify(parameters) : String(toUserId),
        status: NOTIFICATION_STATUS.PENDING,
      });
      notificationsSent++;
      res.status(201).json({ success: true, notification });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      notificationQueueSize--;
    }
  });

  // ── POST /api/uns/group-announcement/email ─────────────────────────────────
  // Mirrors notifyFusionGroupAnnouncementViaEmail(groupId, note)
  // Runs EmailGroupAnnouncementTask: gets members with emailNotification > 0,
  // appends defaultMigEmailDomain to each username, sends in blocks of 100.
  // Body: { groupId, message, subject }
  app.post("/api/uns/group-announcement/email", async (req, res) => {
    const schema = z.object({
      groupId: z.number().int().min(1),
      message: z.string().min(1),
      subject: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { groupId, message, subject } = parsed.data;
    res.status(202).json({ success: true, queued: true });

    // Run EmailGroupAnnouncementTask logic asynchronously (mirrors taskService.execute)
    setImmediate(async () => {
      try {
        const members = await storage.getGroupMembersForEmailNotification(groupId);
        console.info(`found ${members.length} members in group ${groupId} to notify via email, groupEmailBlockSize = ${GROUP_EMAIL_BLOCK_SIZE}`);
        let block: string[] = [];
        let emailCount = 0;
        for (let i = 0; i < members.length; i++) {
          block.push(members[i] + DEFAULT_MIG_EMAIL_DOMAIN);
          if (block.length >= GROUP_EMAIL_BLOCK_SIZE) {
            await enqueueEmail(block, subject, message);
            emailCount += block.length;
            block = [];
          }
        }
        if (block.length > 0) {
          await enqueueEmail(block, subject, message);
          emailCount += block.length;
        }
        console.info(`created ${emailCount} emails for group ${groupId} to queue`);
      } catch (e: any) {
        console.error(`failed group email announcement for group ${groupId}:`, e.message);
      }
    });
  });

  // ── POST /api/uns/group-announcement/sms ──────────────────────────────────
  // Mirrors notifyFusionGroupAnnouncementViaSMS(groupId, note)
  // If smsSubType == 0, sets to GROUP_ANNOUNCEMENT_NOTIFICATION (1).
  // Runs SMSGroupAnnouncementTask: gets members with smsNotification > 0 + phone.
  // Body: { groupId, message, smsSubType? }
  app.post("/api/uns/group-announcement/sms", async (req, res) => {
    const schema = z.object({
      groupId: z.number().int().min(1),
      message: z.string().min(1),
      smsSubType: z.number().int().min(0).optional().default(0),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    let { groupId, message, smsSubType } = parsed.data;
    if (smsSubType === 0) smsSubType = SMS_SUBTYPE_GROUP_ANNOUNCEMENT;

    if (smsSubType < 1) {
      console.warn(`unable to send SMS notification [${message}] for groupId [${groupId}], smsSubType was not specified, aborting...`);
      return res.status(400).json({ error: "smsSubType must be >= 1" });
    }

    res.status(202).json({ success: true, queued: true, smsSubType });

    setImmediate(async () => {
      try {
        const members = await storage.getGroupMembersForSMSNotification(groupId);
        console.debug(`found ${members.length} members to notify via sms`);
        for (const member of members) {
          await enqueueSMS(member.username, member.mobileNumber, message, smsSubType);
        }
      } catch (e: any) {
        console.error(`failed group SMS announcement for group ${groupId}:`, e.message);
      }
    });
  });

  // ── POST /api/uns/group-event/sms ─────────────────────────────────────────
  // Mirrors notifyFusionGroupEventViaSMS(groupId, note)
  // If smsSubType == 0, sets to GROUP_EVENT_NOTIFICATION (2).
  // Runs SMSGroupEventTask: gets members with eventNotification > 0 + phone.
  // Body: { groupId, message, smsSubType? }
  app.post("/api/uns/group-event/sms", async (req, res) => {
    const schema = z.object({
      groupId: z.number().int().min(1),
      message: z.string().min(1),
      smsSubType: z.number().int().min(0).optional().default(0),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    let { groupId, message, smsSubType } = parsed.data;
    if (smsSubType === 0) smsSubType = SMS_SUBTYPE_GROUP_EVENT;

    if (smsSubType < 1) {
      console.warn(`unable to send SMS notification [${message}] for groupId [${groupId}], smsSubType was not specified, aborting...`);
      return res.status(400).json({ error: "smsSubType must be >= 1" });
    }

    res.status(202).json({ success: true, queued: true, smsSubType });

    setImmediate(async () => {
      try {
        const members = await storage.getGroupMembersForGroupEventSMSNotification(groupId);
        console.debug(`found ${members.length} members to notify via sms`);
        for (const member of members) {
          await enqueueSMS(member.username, member.mobileNumber, message, smsSubType);
        }
      } catch (e: any) {
        console.error(`failed group event SMS for group ${groupId}:`, e.message);
      }
    });
  });

  // ── POST /api/uns/group/alert ──────────────────────────────────────────────
  // Mirrors notifyFusionGroupViaAlert(groupId, message)
  // Runs AlertGroupTask: gets members with eventNotification > 0,
  // builds AlertNote in blocks of ALERT_BLOCK_SIZE (100).
  // Body: { groupId, message }
  app.post("/api/uns/group/alert", async (req, res) => {
    const schema = z.object({
      groupId: z.number().int().min(1),
      message: z.string().min(1).max(500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { groupId, message } = parsed.data;
    res.status(202).json({ success: true, queued: true });

    setImmediate(async () => {
      try {
        const users = await storage.getGroupMembersForGroupEventAlertNotification(groupId);
        console.debug(`building alert notes for group [${groupId}]`);
        let block: string[] = [];
        let totalCount = 0;
        for (const user of users) {
          block.push(user);
          if (block.length >= ALERT_BLOCK_SIZE) {
            await enqueueAlert(block, message);
            totalCount += block.length;
            block = [];
          }
        }
        if (block.length > 0) {
          await enqueueAlert(block, message);
          totalCount += block.length;
        }
        console.debug(`done adding ${totalCount} alerts for group ${groupId} to queue`);
      } catch (e: any) {
        console.error(`failed group alert for group ${groupId}:`, e.message);
      }
    });
  });

  // ── POST /api/uns/group-post-subscribers/email ─────────────────────────────
  // Mirrors notifyFusionGroupPostSubscribersViaEmail(userPostId, note)
  // Runs EmailGroupPostSubscribersTask: gets email-subscribed post subscribers.
  // Body: { userPostId, message, subject }
  app.post("/api/uns/group-post-subscribers/email", async (req, res) => {
    const schema = z.object({
      userPostId: z.number().int().min(1),
      message: z.string().min(1),
      subject: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { userPostId, message, subject } = parsed.data;
    res.status(202).json({ success: true, queued: true });

    setImmediate(async () => {
      try {
        const members = await storage.getGroupPostSubscribersForEmail(userPostId);
        console.info(`found ${members.length} post subscribers to notify via email`);
        let block: string[] = [];
        for (let i = 0; i < members.length; i++) {
          block.push(members[i] + DEFAULT_MIG_EMAIL_DOMAIN);
          if (block.length >= GROUP_EMAIL_BLOCK_SIZE) {
            await enqueueEmail(block, subject, message);
            block = [];
          }
        }
        if (block.length > 0) await enqueueEmail(block, subject, message);
      } catch (e: any) {
        console.error(`failed group post subscriber email for post ${userPostId}:`, e.message);
      }
    });
  });

  // ── POST /api/uns/email/noreply ────────────────────────────────────────────
  // Mirrors sendEmailFromNoReply(destinationAddress, subject, body)
  // Calls sendEmailFromNoReplyWithType with mimeType=null.
  // Body: { destinationAddress, subject, body }
  app.post("/api/uns/email/noreply", async (req, res) => {
    const schema = z.object({
      destinationAddress: z.string().email(),
      subject: z.string().min(1).max(200),
      body: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { destinationAddress, subject, body } = parsed.data;
    try {
      const count = await enqueueEmail([destinationAddress], subject, body);
      res.status(201).json({ success: true, enqueued: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/email/noreply-typed ─────────────────────────────────────
  // Mirrors sendEmailFromNoReplyWithType(destinationAddress, subject, body, mimeType)
  // Adds mimeType to the email note. mimeType stored in subject prefix.
  // Body: { destinationAddress, subject, body, mimeType }
  app.post("/api/uns/email/noreply-typed", async (req, res) => {
    const schema = z.object({
      destinationAddress: z.string().email(),
      subject: z.string().min(1).max(200),
      body: z.string().min(1),
      mimeType: z.enum(["text/plain", "text/html"]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { destinationAddress, subject, body, mimeType } = parsed.data;
    try {
      const notification = await storage.createNotification({
        username: destinationAddress,
        type: NOTIFICATION_TYPE.EMAIL,
        subject: `MIME:${mimeType}|${subject}`,
        message: body,
        status: NOTIFICATION_STATUS.PENDING,
      });
      emailsSent++;
      res.status(201).json({ success: true, notification });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/email/fusion-user ───────────────────────────────────────
  // Mirrors notifyUsersViaFusionEmail(sender, senderPassword, recipients, note)
  // Creates EmailNote with sender + senderPassword, adds recipients.
  // Sender gets email from defaultMigEmailDomain appended.
  // Body: { sender, senderPassword, recipients: string[], message, subject }
  app.post("/api/uns/email/fusion-user", async (req, res) => {
    const schema = z.object({
      sender: z.string().min(1),
      senderPassword: z.string().min(1),
      recipients: z.array(z.string().email()).min(1).max(100),
      message: z.string().min(1),
      subject: z.string().min(1).max(200),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { sender, senderPassword, recipients, message, subject } = parsed.data;
    const senderEmail = sender + DEFAULT_MIG_EMAIL_DOMAIN;
    try {
      const count = await enqueueEmail(recipients, subject, message, senderEmail);
      res.status(201).json({ success: true, enqueued: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/sms/user ─────────────────────────────────────────────────
  // Mirrors notifyFusionUserViaSMS(username, note)
  // Looks up phoneNumber from userDAO if not provided.
  // Validates smsSubType >= 1.
  // Body: { username, message, smsSubType, phoneNumber? }
  app.post("/api/uns/sms/user", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      message: z.string().min(1).max(160),
      smsSubType: z.number().int().min(1, "smsSubType must be >= 1"),
      phoneNumber: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, message, smsSubType, phoneNumber: providedPhone } = parsed.data;

    let phoneNumber = providedPhone ?? "";
    if (!phoneNumber) {
      const found = await storage.getMobileNumberForUser(username);
      if (!found) {
        console.error(`failed to find a mobile phone for user [${username}]`);
        return res.status(422).json({ error: `failed to find a mobile phone for user [${username}]` });
      }
      phoneNumber = found;
    }

    if (smsSubType < 1) {
      console.error(`failed to find a sms subtype for user [${username}]`);
      return res.status(400).json({ error: `failed to find a sms subtype for user [${username}]` });
    }

    try {
      await enqueueSMS(username, phoneNumber, message, smsSubType);
      res.status(201).json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/alert/user ───────────────────────────────────────────────
  // Mirrors notifyFusionUserViaAlert(username, message)
  // Creates AlertNote with single user and adds to alert queue.
  // Body: { username, message }
  app.post("/api/uns/alert/user", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      message: z.string().min(1).max(500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, message } = parsed.data;
    try {
      await enqueueAlert([username], message);
      res.status(201).json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/uns/stats ─────────────────────────────────────────────────────
  // Mirrors UserNotificationServiceAdminI.getStats()
  // Returns emailsSent, smsSent, alertsSent, notificationsSent + queue sizes.
  app.get("/api/uns/stats", (_req, res) => {
    res.json({
      emailsSent,
      smsSent,
      alertsSent,
      notificationsSent,
      emailQueueSize: 0,
      smsQueueSize: 0,
      alertQueueSize: 0,
      notificationQueueSize,
    });
  });

  // ── GET /api/uns/pending/:userId ───────────────────────────────────────────
  // Mirrors getPendingNotificationsForUser(userId)
  // Returns Map<notfnType, count> for all pending notifications of the user.
  // In TS: userId is the username string (username or UUID-lookup via ?byId=true).
  app.get("/api/uns/pending/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      let username = userId;
      if (req.query.byId === "true") {
        const user = await storage.getUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        username = user.username;
      }

      const countByType = await storage.getNotificationCountByType(username);
      res.json({ userId, username, pendingByType: countByType });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/notification-counter/:userId ────────────────────────────
  // Mirrors sendNotificationCounterToUser(userId)
  // Sums all pending notifications by type and returns total count.
  // In Java, this pushes the count to the online user via Ice. Here we just return it.
  app.post("/api/uns/notification-counter/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      let username = userId;
      if (req.query.byId === "true") {
        const user = await storage.getUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        username = user.username;
      }

      const countByType = await storage.getNotificationCountByType(username);
      let totalPending = 0;
      for (const type of Object.keys(countByType)) {
        totalPending += countByType[type];
      }

      const msgString = `migAlerts (${totalPending})`;
      res.json({
        userId,
        username,
        totalPending,
        message: msgString,
        parameters: {
          message: msgString,
          totalPending: String(totalPending),
          url: "",
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/uns/notifications/:userId/:notfnType ──────────────────────
  // Mirrors clearAllNotificationsByTypeForUser(userId, notfnType)
  // Deletes all notifications of a type for a user.
  // Optionally stores read copy (Notifications.storeRead=true in Java).
  // Query: ?storeRead=true to store backup
  app.delete("/api/uns/notifications/:userId/:notfnType", async (req, res) => {
    const { userId, notfnType } = req.params;
    const storeRead = req.query.storeRead === "true";
    try {
      let username = userId;
      if (req.query.byId === "true") {
        const user = await storage.getUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        username = user.username;
      }

      console.debug(`Clearing all type[${notfnType}] notifications for user:${userId}`);
      const deleted = await storage.deleteAllNotificationsByType(username, notfnType);

      if (storeRead && deleted.length > 0) {
        for (const n of deleted) {
          await storage.createNotification({
            username: n.username,
            type: `${n.type}_read`,
            subject: n.subject,
            message: n.message,
            status: NOTIFICATION_STATUS.SENT,
          });
        }
      }

      res.json({ success: true, deleted: deleted.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/uns/notifications/:userId ─────────────────────────────────
  // Mirrors clearNotificationsForUser(userId, notfnType, keys[])
  // Deletes specific notifications by keys (notification IDs).
  // Body: { notfnType, keys: string[] }
  app.delete("/api/uns/notifications/:userId", async (req, res) => {
    const { userId } = req.params;
    const schema = z.object({
      notfnType: z.string().min(1),
      keys: z.array(z.string().min(1)).min(1),
      storeRead: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { notfnType, keys, storeRead } = parsed.data;
    try {
      let username = userId;
      if (req.query.byId === "true") {
        const user = await storage.getUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        username = user.username;
      }

      console.debug(`Clearing multiple type[${notfnType}] notifications for user:${userId}`);
      const deleted = await storage.deleteNotificationsByIds(keys);

      if (storeRead && deleted.length > 0) {
        for (const n of deleted) {
          await storage.createNotification({
            username: n.username,
            type: `${n.type}_read`,
            subject: n.subject,
            message: n.message,
            status: NOTIFICATION_STATUS.SENT,
          });
        }
      }

      res.json({ success: true, deleted: deleted.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/purge/:userId ────────────────────────────────────────────
  // Mirrors UserNotificationPurger.trimUserNotificationItemsIfNeeded(userId)
  // Counts all notifications; if over MAX_NOTIFICATIONS, trims to NOTIFICATION_TRUNCATION_TARGET
  // by deleting the oldest entries (mirrors trimUserNotifications).
  app.post("/api/uns/purge/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
      let username = userId;
      if (req.query.byId === "true") {
        const user = await storage.getUser(userId);
        if (!user) return res.status(404).json({ error: "User not found" });
        username = user.username;
      }

      const deleted = await storage.purgeOldNotifications(username, MAX_NOTIFICATIONS, NOTIFICATION_TRUNCATION_TARGET);
      res.json({ success: true, deleted });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/alert ────────────────────────────────────────────────────
  // Send an alert notification to one or more users (mirrors AlertNote.java)
  // Body: { message, usernames: string[] }
  app.post("/api/uns/alert", async (req, res) => {
    const schema = z.object({
      message: z.string().min(1).max(500),
      usernames: z.array(z.string().min(1)).min(1).max(500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { message, usernames } = parsed.data;
    try {
      const count = await enqueueAlert(usernames, message);
      res.status(201).json({ success: true, sent: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/sms ──────────────────────────────────────────────────────
  // Send an SMS note to a user (mirrors SMSNote.java)
  // Body: { username, phoneNumber, message, subType? }
  app.post("/api/uns/sms", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      phoneNumber: z.string().min(7).max(20).regex(/^\+?[0-9]+$/),
      message: z.string().min(1).max(160),
      subType: z.number().int().min(1).max(3).optional().default(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, phoneNumber, message, subType } = parsed.data;
    try {
      await enqueueSMS(username, phoneNumber, message, subType);
      res.status(201).json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/email ────────────────────────────────────────────────────
  // Send an email note (mirrors EmailNote.java)
  // Body: { recipients: string[], subject, message, mimeType? }
  app.post("/api/uns/email", async (req, res) => {
    const schema = z.object({
      recipients: z.array(z.string().email()).min(1).max(100),
      subject: z.string().min(1).max(200),
      message: z.string().min(1),
      mimeType: z.enum(["text/plain", "text/html"]).optional().default("text/plain"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { recipients, subject, message } = parsed.data;
    try {
      const count = await enqueueEmail(recipients, subject, message);
      res.status(201).json({ success: true, sent: count });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/uns/notifications/me ─────────────────────────────────────────
  // Fetch current user's ALERT notifications (newest first), includes active system alerts.
  // Mirrors UserNotificationServiceI.getNotificationsForUser()
  // MUST be registered BEFORE /api/uns/notifications/:username to avoid route shadowing.
  app.get("/api/uns/notifications/me", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    try {
      const alerts = await storage.getNotifications(user.username, limit, NOTIFICATION_TYPE.ALERT);
      const systemAlerts = await storage.getAlertMessages(1); // status=1 ACTIVE
      const unread = alerts.filter(n => n.status === NOTIFICATION_STATUS.PENDING).length;
      res.json({ notifications: alerts, systemAlerts, unread });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/uns/notifications/me/count ───────────────────────────────────
  // Returns unread (PENDING) alert count for badge display.
  // MUST be registered BEFORE /api/uns/notifications/:username to avoid route shadowing.
  app.get("/api/uns/notifications/me/count", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });
    try {
      const pending = await storage.getNotifications(user.username, 500, NOTIFICATION_TYPE.ALERT, NOTIFICATION_STATUS.PENDING);
      res.json({ count: pending.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/uns/notifications/me/read-all ──────────────────────────────
  // Mark all PENDING ALERT notifications as SENT (read).
  // MUST be registered BEFORE /api/uns/notifications/:username to avoid route shadowing.
  app.patch("/api/uns/notifications/me/read-all", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });
    try {
      const pending = await storage.getNotifications(user.username, 500, NOTIFICATION_TYPE.ALERT, NOTIFICATION_STATUS.PENDING);
      await Promise.all(pending.map(n => storage.updateNotificationStatus(n.id, NOTIFICATION_STATUS.SENT)));
      res.json({ success: true, marked: pending.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/uns/notifications/:username ──────────────────────────────────
  // Get notifications for a user
  // Query: ?limit=20&type=ALERT|EMAIL|SMS&status=1
  app.get("/api/uns/notifications/:username", async (req, res) => {
    const { username } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const type = req.query.type as string | undefined;
    const status = req.query.status ? parseInt(req.query.status as string) : undefined;

    try {
      const notifs = await storage.getNotifications(username, limit, type, status);
      res.json({ username, notifications: notifs, count: notifs.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/uns/notification/:id/status ────────────────────────────────
  // Update notification status
  // Body: { status }
  app.patch("/api/uns/notification/:id/status", async (req, res) => {
    const { id } = req.params;
    const schema = z.object({ status: z.number().int().min(1).max(3) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const updated = await storage.updateNotificationStatus(id, parsed.data.status);
      if (!updated) return res.status(404).json({ error: "Notification not found" });
      res.json({ success: true, notification: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/uns/dispatch-pending ────────────────────────────────────────
  // Dispatch all pending notifications (job scheduler endpoint)
  app.post("/api/uns/dispatch-pending", async (_req, res) => {
    try {
      const pending = await storage.getPendingNotifications(500);
      let dispatched = 0;
      for (const note of pending) {
        await storage.updateNotificationStatus(note.id, NOTIFICATION_STATUS.SENT);
        dispatched++;
      }
      res.json({ success: true, dispatched });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/uns/constants ────────────────────────────────────────────────
  app.get("/api/uns/constants", (_req, res) => {
    res.json({
      types: NOTIFICATION_TYPE,
      statuses: NOTIFICATION_STATUS,
      smsSubTypes: {
        GROUP_ANNOUNCEMENT_NOTIFICATION: SMS_SUBTYPE_GROUP_ANNOUNCEMENT,
        GROUP_EVENT_NOTIFICATION: SMS_SUBTYPE_GROUP_EVENT,
      },
      defaults: {
        defaultMigEmailDomain: DEFAULT_MIG_EMAIL_DOMAIN,
        groupEmailBlockSize: GROUP_EMAIL_BLOCK_SIZE,
        alertBlockSize: ALERT_BLOCK_SIZE,
        maxNotifications: MAX_NOTIFICATIONS,
        notificationTruncationTarget: NOTIFICATION_TRUNCATION_TARGET,
      },
    });
  });
}
