import logger from "../utils/logger.js";
import { runPostgresPreflight } from "../db/pgsql.js";
import { runRedisPreflight } from "../db/redis.js";
import { ensureTwilioClientReadyOrExit } from "../utils/twilio.js";

export async function runStartupPreflight(): Promise<void> {
  logger.info("[preflight] starting startup checks");
  await runPostgresPreflight();
  await runRedisPreflight();
  await ensureTwilioClientReadyOrExit();
  logger.info("[preflight] startup checks passed");
}
