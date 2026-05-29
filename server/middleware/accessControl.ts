/**
 * Authenticated Access Control
 * Mirrors com/projectgoth/fusion/accesscontrol/AuthenticatedAccessControl.java
 *
 * The Java system gates 32 action types behind mobile-verified OR email-verified.
 * Our implementation uses emailVerified as the single verification signal (we have
 * no phone-verification flow yet).  Mobile-only types (true, false) also accept
 * emailVerified as a practical substitute until SMS verification is added.
 *
 * Usage:
 *   app.post("/api/contacts/request/:username",
 *     requireVerified("ADD_FRIEND"), handler)
 */

import type { Request, Response, NextFunction } from "express";
import { storage } from "../storage";

// ─── Action types (mirrors AuthenticatedAccessControlTypeEnum) ────────────────
// (mobileVerifiedAllowed, emailVerifiedAllowed) — both true means either suffices.
// mobile-only (true, false) — since we have no SMS flow, emailVerified also passes.

export type AccessControlType =
  | "ADD_FRIEND"
  | "BE_ADDED_AS_FRIEND"
  | "JOIN_GROUP"
  | "CREATE_GROUP_CHAT"
  | "TRANSFER_CREDIT_OUT"
  | "RECEIVE_CREDIT_TRANSFER"
  | "BUY_AVATAR"
  | "BUY_EMOTICONPACK"
  | "BUY_VIRTUALGIFT"
  | "BUY_PAIDEMOTE"
  | "ENTER_CHATROOM"
  | "SEND_GROUP_INVITE"
  | "RECEIVE_GROUP_INVITE"
  | "LOGIN_AFTER_90DAYS"
  | "PARTICIPATE_IN_MARKETING_MECHANICS"
  | "REGISTER_AS_MERCHANT"
  | "EDIT_PROFILE"
  | "RECEIVE_USER_LIKE"
  | "UPLOAD_PHOTO"
  | "RECEIVE_AVATAR_VOTE"
  | "RETURN_VERIFIED_UPON_LOGIN"
  | "OTHER_IM_LOGIN"
  | "UPLOAD_FILE"
  | "SEND_MIG33_EMAIL"
  | "MAKE_CREDIT_CARD_PAYMENT"
  | "MAKE_BANK_TRANSFER"
  | "CREATE_USER_POST_IN_GROUPS"
  | "ADD_CONTACT_GROUP"
  | "INVITE_FRIEND"
  | "CHANGE_ROOM_OWNER_EMAIL"
  | "SEND_BINARY_DATA"
  | "SEND_PRIVATE_MESSAGE_TO_NON_CONTACT";

// Check if a user passes access control for a given action type.
// Returns true if the user is email-verified (covers both mobile+email and mobile-only types).
export async function checkAccess(
  type: AccessControlType,
  userId: string
): Promise<boolean> {
  const user = await storage.getUser(userId);
  if (!user) return false;
  return user.emailVerified === true;
}

// Express middleware — rejects with 403 + code EMAIL_NOT_VERIFIED if not verified.
export function requireVerified(type: AccessControlType) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Not logged in yet" });
    }
    const allowed = await checkAccess(type, userId);
    if (!allowed) {
      return res.status(403).json({
        code: "EMAIL_NOT_VERIFIED",
        type,
        message: "Verifikasi email kamu terlebih dahulu untuk menggunakan fitur ini.",
      });
    }
    return next();
  };
}
