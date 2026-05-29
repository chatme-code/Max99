/**
 * tcpTokens.ts
 *
 * Short-lived tokens issued by the HTTP login endpoint so that mobile clients
 * can authenticate over the binary FusionPacket TCP connection without the
 * server needing to store cleartext passwords.
 *
 * Flow:
 *   1. Mobile POST /api/auth/login  → server returns { tcpToken }
 *   2. Mobile opens TCP socket, sends LOGIN(username)
 *   3. Server replies with LOGIN_CHALLENGE(challenge, sessionId)
 *   4. Mobile computes SHA-1(challenge + tcpToken) and sends LOGIN_RESPONSE
 *   5. Server looks up token, verifies SHA-1(challenge + token), sends LOGIN_OK
 */

import { randomUUID } from "crypto";
import { verifyPasswordHash } from "./fusionCodec";

interface TcpTokenEntry {
  userId:    string;
  username:  string;
  token:     string;
  expiresAt: number;       // Unix ms
}

const TOKEN_TTL_MS     = 5 * 60 * 1_000;       // 5 min  — binary challenge/response
const TOKEN_TTL_JSON   = 7 * 24 * 60 * 60 * 1_000; // 7 days — JSON TCP reconnects

const tokenStore = new Map<string, TcpTokenEntry>();

/** Create and persist a new TCP auth token for the given user. */
export function createTcpToken(userId: string, username: string): string {
  const token = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokenStore.set(token, { userId, username, token, expiresAt });
  // Also index by userId so we can invalidate old tokens on re-login
  purgeUserTokens(userId, token);
  return token;
}

/** Retrieve the entry for a given token (returns undefined if expired/missing). */
export function getTcpToken(token: string): TcpTokenEntry | undefined {
  const entry = tokenStore.get(token);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    tokenStore.delete(token);
    return undefined;
  }
  return entry;
}

/** Look up a token by userId (newest valid token). */
export function getTcpTokenByUserId(userId: string): TcpTokenEntry | undefined {
  let found: TcpTokenEntry | undefined;
  const now = Date.now();
  Array.from(tokenStore.values()).forEach((entry) => {
    if (entry.userId === userId && now <= entry.expiresAt) {
      if (!found || entry.expiresAt > found.expiresAt) found = entry;
    }
  });
  return found;
}

/**
 * Find and verify a TCP token for the given user by checking the SHA-1
 * challenge/response hash against every valid token for this userId.
 *
 * Returns the matching entry (so the caller can consume it), or undefined.
 */
export function findTokenForUser(
  userId: string,
  clientHash: number,
  challenge: string,
): TcpTokenEntry | undefined {
  const now = Date.now();
  const entries = Array.from(tokenStore.values());
  return entries.find(
    (entry) =>
      entry.userId === userId &&
      now <= entry.expiresAt &&
      verifyPasswordHash(challenge, entry.token, clientHash),
  );
}

/**
 * Verify a raw tcpToken string for a user (JSON protocol).
 * Unlike findTokenForUser (which verifies SHA-1 hash for binary protocol),
 * this checks the plain token UUID directly — used by the JSON TCP LOGIN.
 * Does NOT consume the token so reconnects keep working.
 * Also extends the token TTL to 7 days on each successful verification.
 */
export function verifyTcpToken(userId: string, token: string): boolean {
  const entry = tokenStore.get(token);
  if (!entry) return false;
  if (entry.userId !== userId) return false;
  if (Date.now() > entry.expiresAt) {
    tokenStore.delete(token);
    return false;
  }
  // Extend TTL so reconnects keep working for the session lifetime
  entry.expiresAt = Date.now() + TOKEN_TTL_JSON;
  return true;
}

/** Invalidate a specific token (e.g. after successful TCP auth). */
export function consumeTcpToken(token: string): void {
  tokenStore.delete(token);
}

/** Remove all tokens for a user except the one provided. */
function purgeUserTokens(userId: string, keepToken: string): void {
  Array.from(tokenStore.entries()).forEach(([key, entry]) => {
    if (entry.userId === userId && key !== keepToken) tokenStore.delete(key);
  });
}

/** Periodic cleanup of expired tokens (run every minute). */
setInterval(() => {
  const now = Date.now();
  Array.from(tokenStore.entries()).forEach(([key, entry]) => {
    if (now > entry.expiresAt) tokenStore.delete(key);
  });
}, 60_000).unref();
