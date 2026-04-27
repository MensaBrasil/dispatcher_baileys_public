import { runPostgresPreflight } from "../db/pgsql.js";
import { runRedisPreflight } from "../db/redis.js";
import logger from "../utils/logger.js";
import { ensureTwilioClientReadyOrExit } from "../utils/twilio.js";

export async function runStartupPreflight(): Promise<void> {
  logger.info("[preflight] iniciando verificações de inicialização");
  await runPostgresPreflight();
  await runRedisPreflight();
  await ensureTwilioClientReadyOrExit();
  logger.info("[preflight] verificações de inicialização concluídas com sucesso");
}
