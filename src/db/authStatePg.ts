import { config as configDotenv } from "dotenv";
import { Pool } from "pg";
import logger from "../utils/logger.js";

configDotenv({ path: ".env" });

function readAuthDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("Missing required auth DB env var: DATABASE_URL");
  }
  return connectionString;
}

export function getAuthSessionId(defaultSessionId = "dispatcher"): string {
  return process.env.WPP_AUTH_SESSION_ID?.trim() || process.env.WA_AUTH_SESSION_ID?.trim() || defaultSessionId;
}

let authPool: Pool | null = null;

export function getAuthPool(): Pool {
  if (authPool) return authPool;

  authPool = new Pool({ connectionString: readAuthDatabaseUrl() });
  authPool.on("error", (err) => {
    logger.error({ err }, "[auth-pg] unexpected pool error");
  });

  return authPool;
}
