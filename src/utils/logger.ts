import { config as configDotenv } from "dotenv";
import pino from "pino";

configDotenv({ path: ".env" });

const level = (process.env.LOG_LEVEL ?? "info") as pino.LevelWithSilent;
const isPretty = process.env.NODE_ENV !== "production" || process.env.PRETTY_LOGS === "true";
const suppressGenericWhatsAppMessageLogs = process.env.LOG_WA_RECEIVED_MESSAGES !== "true";

function isSuppressedGenericWhatsAppMessageLog(args: Parameters<pino.LogFn>): boolean {
  if (!suppressGenericWhatsAppMessageLogs) return false;

  let message: string | undefined;
  for (const arg of args) {
    if (typeof arg === "string") message = arg;
  }
  return message === "[wa] Mensagem recebida" || message === "[wa] Message received";
}

const logger = pino({
  level,
  base: undefined,
  redact: ["password", "authorization", "token"],
  hooks: {
    logMethod(args, method) {
      if (isSuppressedGenericWhatsAppMessageLog(args)) return;
      method.apply(this, args);
    },
  },
  transport: isPretty
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          // Show compact time like [19:23:04]
          translateTime: "SYS:HH:MM:ss",
          singleLine: false,
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

export default logger;

const validLevels = new Set<pino.LevelWithSilent>(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function sanitizeLevel(input: string | undefined, fallback: pino.LevelWithSilent): pino.LevelWithSilent {
  if (input && validLevels.has(input as pino.LevelWithSilent)) {
    return input as pino.LevelWithSilent;
  }
  return fallback;
}
