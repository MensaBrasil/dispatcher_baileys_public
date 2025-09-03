import { config as configDotenv } from "dotenv";
import pino from "pino";

configDotenv({ path: ".env" });

const level = (process.env.LOG_LEVEL ?? "info") as pino.LevelWithSilent;
const isPretty = process.env.NODE_ENV !== "production" || process.env.PRETTY_LOGS === "true";

const logger = pino({
  level,
  base: undefined,
  redact: ["password", "authorization", "token"],
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
