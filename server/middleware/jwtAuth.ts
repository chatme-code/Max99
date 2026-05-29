import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "migxchat-secret-key-2024";
const JWT_EXPIRES_IN = "30d";

export interface JwtPayload {
  userId: string;
  username: string;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Middleware that accepts BOTH session cookie AND Bearer JWT token.
 * If a valid Bearer token is found, it sets req.session.userId automatically
 * so all existing route handlers that check req.session.userId keep working.
 */
export function jwtAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId) {
    return next();
  }

  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = verifyJwt(token);
    if (payload) {
      req.session.userId = payload.userId;
    }
  }

  next();
}
