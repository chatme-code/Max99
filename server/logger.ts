import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const SENSITIVE_PATHS = [
  "password",
  "passwordHash",
  "hashedPassword",
  "pin",
  "transfer_pin",
  "transferPin",
  "token",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "email",
  "toEmail",
  "verifyUrl",
  "verificationUrl",
  "resetToken",
  "secret",
  "apiKey",
  "api_key",
  "credits",
  "balance",
  "fundedBalance",
  "amount",
  "req.body.password",
  "req.body.pin",
  "req.body.token",
  "req.body.email",
  "req.body.amount",
  "req.body.credits",
];

export const logger = pino({
  level: isDev ? "debug" : "warn",
  redact: {
    paths: SENSITIVE_PATHS,
    censor: "***",
  },
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  }),
});

export const SKIP_LOG_PATHS = new Set([
  "/api/chatsync/version",
  "/api/contacts",
  "/api/uns/notifications",
  "/api/chatrooms",
]);

export const SKIP_LOG_PREFIXES = [
  "/api/feed",
];

export function log(message: string, source = "express"): void {
  logger.info({ source }, message);
}
