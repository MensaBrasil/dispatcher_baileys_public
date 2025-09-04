import { config as configDotenv } from "dotenv";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import qrcode from "qrcode-terminal";
import logger, { sanitizeLevel } from "./utils/logger.js";
import type { BoomError } from "./types/ErrorTypes.js";
import { addMembersToGroups } from "./core/addTask.js";
import { removeMembersFromGroups } from "./core/removeTask.js";
import { scanGroups } from "./core/scanTask.js";
import { getPhoneNumbersWithStatus, saveGroupsToList } from "./db/pgsql.js";
import { preprocessPhoneNumbers } from "./utils/phoneCheck.js";
import { delaySecs } from "./utils/delay.js";
import { Command } from "commander";
import { processGroupsBaileys } from "./utils/groups.js";
import { ensureTwilioClientReadyOrExit } from "./utils/twilio.js";
import { checkPhoneNumber } from "./utils/phoneCheck.js";
import { isOrgMBGroup } from "./utils/checkGroupType.js";

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

  // Sanity check: ensure a known number exists in DB
  const sanityNumberRaw = process.env.SANITY_CHECK;
  if (sanityNumberRaw) {
    try {
      const rows = await getPhoneNumbersWithStatus();
      const phoneMap = preprocessPhoneNumbers(rows);
      const sanitized = sanityNumberRaw.replace(/\D/g, "");
      const checkResult = checkPhoneNumber(phoneMap, sanitized);
      if (!checkResult.found) {
        logger.fatal({ phone: sanitized }, "Sanity check failed: number not found in DB");
        process.exit(1);
      } else {
        logger.info({ phone: sanitized }, "Sanity check passed");
      }
    } catch (err) {
      logger.fatal({ err }, "Sanity check error; exiting");
      process.exit(1);
    }
  }

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

  // Orchestration: run tasks once per cycle (seconds only)
  const cycleDelaySeconds = Math.max(1, Math.floor(Number(process.env.CYCLE_DELAY_SECONDS ?? 1800)));
  const cycleJitterSeconds = Math.max(0, Math.floor(Number(process.env.CYCLE_JITTER_SECONDS ?? 0)));
  let loopStarted = false;
  let isConnected = false;
  let isCycleRunning = false;
  let pendingImmediateRunOnOpen = false;

  async function runCycleOnce() {
    try {
      if (!isConnected) {
        // mark to run immediately once connection is restored
        pendingImmediateRunOnOpen = true;
        logger.warn("[wa] not connected; skipping cycle run");
        return;
      }
      if (isCycleRunning) {
        logger.warn("Cycle already running; skipping overlapping run");
        return;
      }
      isCycleRunning = true;
      // Fetch and classify groups using Baileys
      const { adminGroups } = await processGroupsBaileys(sock);
      // Filter out OrgMB groups only (keep all others)
      const mensaAdminGroups = adminGroups.filter((g) => !isOrgMBGroup(g.subject ?? g.name ?? ""));
      // Update DB with current groups list (OrgMB already excluded)
      try {
        const toSave = mensaAdminGroups.map((g) => ({ group_id: g.id, group_name: g.subject ?? g.name ?? g.id }));
        await saveGroupsToList(toSave);
      } catch (err) {
        logger.warn({ err }, "Failed to save groups list to DB");
      }

      // 1) Add task (id + name/subject)
      if (runAdd) {
        const addTaskGroups = mensaAdminGroups.map((g) => ({ id: g.id, subject: g.subject, name: g.name }));
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
        await removeMembersFromGroups(mensaAdminGroups, phoneMap);
      }

      if (runRemove && (runScan || false)) {
        await delaySecs(actionDelayMin, actionDelayMax, actionDelayJitter);
      }

      // 4) Scan task
      if (runScan && phoneMap) {
        await scanGroups(mensaAdminGroups, phoneMap);
      }

      // Mini summary
      logger.info(
        { adminGroupsFetched: adminGroups.length, mensaAdminGroups: mensaAdminGroups.length },
        "Cycle summary",
      );
    } catch (err) {
      // If the connection was closed in-between, avoid spamming hard errors
      const code = (err as BoomError)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        logger.fatal({ err }, "Session logged out during cycle; exiting");
        process.exit(1);
      }
      const message = (err as BoomError)?.output?.payload?.message;
      if (message === "Connection Closed" || code === 428) {
        logger.warn({ err }, "Cycle run skipped due to closed connection");
        return;
      }
      logger.error({ err }, "Error running tasks in cycle");
    } finally {
      isCycleRunning = false;
    }
  }

  async function startLoop() {
    if (loopStarted) return;
    loopStarted = true;
    logger.info(
      { intervalSeconds: cycleDelaySeconds, jitterSeconds: cycleJitterSeconds },
      "Starting main loop (one run per interval)",
    );
    // First run immediately
    await runCycleOnce();
    // Then run every cycle
    while (true) {
      const minDelay = Math.max(1, cycleDelaySeconds - cycleJitterSeconds);
      const maxDelay = cycleDelaySeconds + cycleJitterSeconds;
      await delaySecs(minDelay, maxDelay);
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
      isConnected = true;
      logger.info("[wa] connection opened.");
      // Start the orchestrator loop once after connection is open
      if (!loopStarted) {
        startLoop().catch((err) => logger.error({ err }, "Loop start error"));
      } else if (pendingImmediateRunOnOpen && !isCycleRunning) {
        pendingImmediateRunOnOpen = false;
        // Trigger an immediate cycle after reconnect
        runCycleOnce().catch((err) => logger.error({ err }, "Immediate run after reconnect failed"));
      }
    }
    if (connection === "close") {
      isConnected = false;
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
