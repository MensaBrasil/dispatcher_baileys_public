import { config as configDotenv } from "dotenv";
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } from "baileys";
import qrcode from "qrcode-terminal";
import fs from "node:fs/promises";
import path from "node:path";
import logger, { sanitizeLevel } from "../utils/logger.js";
import type { BoomError } from "../types/ErrorTypes.js";

configDotenv({ path: ".env" });

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore if folder exists
  }
}

async function main(): Promise<void> {
  const outDir = path.resolve("tools_results");
  await ensureDir(outDir);

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu("Desktop"),
    logger: logger.child({ module: "baileys-tool" }, { level: sanitizeLevel(process.env.BAILEYS_LOG_LEVEL, "info") }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  let lastQR: string | undefined;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      if (qr !== lastQR) {
        lastQR = qr;
        qrcode.generate(qr, { small: true });
        logger.info("Scan the QR code in WhatsApp > Connected devices");
      }
    }

    if (connection === "open") {
      try {
        const all = await sock.groupFetchAllParticipating();
        const outPath = path.join(outDir, `groups_dump_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        await fs.writeFile(outPath, JSON.stringify(all, null, 2), "utf8");
        logger.info({ outPath }, "Groups metadata saved");
        setTimeout(() => process.exit(0), 50);
      } catch (err) {
        logger.error({ err }, "Failed to fetch or save groups");
        process.exit(1);
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] connection closed: Session logged out. Delete ./auth and link again.");
        process.exit(1);
      }
      logger.warn({ code }, "[wa] connection closed before dumping groups");
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "Unhandled error in tools/dumpGroups");
  process.exit(1);
});
