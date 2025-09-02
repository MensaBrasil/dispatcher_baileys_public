import { config as configDotenv } from "dotenv";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import qrcode from "qrcode-terminal";
import logger, { sanitizeLevel } from "./utils/logger.js";
import type { BoomError } from "./types/ErrorTypes.js";

configDotenv({ path: ".env" });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu("Desktop"),
    logger: logger.child({ module: "baileys" }, { level: sanitizeLevel(process.env.BAILEYS_LOG_LEVEL, "fatal") }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  let lastQR: string | undefined;

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      if (qr !== lastQR) {
        lastQR = qr;
        qrcode.generate(qr, { small: true });
        logger.info("Scan the QR code in WhatsApp > Connected devices");
      }
    }

    if (connection === "open") {
      logger.info("[wa] connection opened.");
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] connection closed: Session logged out. Delete ./auth and link again.");
        process.exit(1);
      }

      logger.warn({ code }, "[wa] connection closed; attempting auto-reconnect...");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down...");
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: error }, "Unhandled error");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception");
  process.exit(1);
});
