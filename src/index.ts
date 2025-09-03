import { config as configDotenv } from "dotenv";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import qrcode from "qrcode-terminal";
import logger, { sanitizeLevel } from "./utils/logger.js";
import type { BoomError } from "./types/ErrorTypes.js";
import { addMembersToGroups } from "./core/addTask.js";
import { removeMembersFromGroups } from "./core/removeTask.js";
import { scanGroups } from "./core/scanTask.js";
import { getPhoneNumbersWithStatus } from "./db/pgsql.js";
import { preprocessPhoneNumbers } from "./utils/phoneCheck.js";
import { delaySecs } from "./utils/delay.js";
import { Command } from "commander";
import { processGroupsBaileys } from "./utils/groups.js";
import { ensureTwilioClientReadyOrExit } from "./utils/twilio.js";

configDotenv({ path: ".env" });

async function main() {
  // CLI options
  const program = new Command();
  program
    .option("--add", "Run add task")
    .option("--remove", "Run remove task")
    .option("--scan", "Run scan task (group membership tracking)");
  program.parse(process.argv);
  const opts = program.opts<{ add?: boolean; remove?: boolean; scan?: boolean }>();
  const anySpecified = Boolean(opts.add || opts.remove || opts.scan);
  const runAdd = anySpecified ? Boolean(opts.add) : true;
  const runRemove = anySpecified ? Boolean(opts.remove) : true;
  const runScan = anySpecified ? Boolean(opts.scan) : process.env.ENABLE_SCAN === "true";

  // Ensure Twilio is properly configured and available before doing any work
  await ensureTwilioClientReadyOrExit();

  const actionDelayMin = Number(process.env.ACTION_DELAY_MIN ?? 1);
  const actionDelayMax = Number(process.env.ACTION_DELAY_MAX ?? 3);
  const actionDelayJitter = Number(process.env.ACTION_DELAY_JITTER ?? 0.5);

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

  // Orchestration: run tasks once per cycle
  const cycleMinutes = Number(process.env.CYCLE_MINUTES ?? 30);
  let loopStarted = false;

  async function runCycleOnce() {
    try {
      // Fetch and classify groups using Baileys
      const { adminGroups } = await processGroupsBaileys(sock);

      // 1) Add task (id + name/subject)
      if (runAdd) {
        const addTaskGroups = adminGroups.map((g) => ({ id: g.id, subject: g.subject, name: g.name }));
        await addMembersToGroups(addTaskGroups);
      }

      // Optional delay between actions that may touch services
      await delaySecs(actionDelayMin, actionDelayMax, actionDelayJitter);

      // 2) Build phone map if needed for remove/scan
      let phoneMap: ReturnType<typeof preprocessPhoneNumbers> | undefined;
      if (runRemove || runScan) {
        const phoneRows = await getPhoneNumbersWithStatus();
        phoneMap = preprocessPhoneNumbers(phoneRows);
      }

      // 3) Remove task
      if (runRemove && phoneMap) {
        await removeMembersFromGroups(adminGroups, phoneMap);
      }

      if (runRemove && (runScan || false)) {
        await delaySecs(actionDelayMin, actionDelayMax, actionDelayJitter);
      }

      // 4) Scan task
      if (runScan && phoneMap) {
        await scanGroups(adminGroups, phoneMap);
      }
    } catch (err) {
      logger.error({ err }, "Error running tasks in cycle");
    }
  }

  async function startLoop() {
    if (loopStarted) return;
    loopStarted = true;
    logger.info({ minutes: cycleMinutes }, "Starting main loop (one run every N minutes)");
    // First run immediately
    await runCycleOnce();
    // Then run every cycle
    // Use an infinite loop with a delay to keep sequencing predictable
    // and ensure a single execution per interval.
    // 30 minutes default, configurable via CYCLE_MINUTES.
    while (true) {
      const waitSeconds = Math.max(1, Math.floor(cycleMinutes * 60));
      await delaySecs(waitSeconds, waitSeconds);
      await runCycleOnce();
    }
  }

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
      // Start the orchestrator loop once after connection is open
      startLoop().catch((err) => logger.error({ err }, "Loop start error"));
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
