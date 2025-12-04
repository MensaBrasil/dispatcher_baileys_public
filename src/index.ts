import { config as configDotenv } from "dotenv";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "baileys";
import type { WASocket } from "baileys";
import type { WAMessageKey } from "baileys";
import qrcode from "qrcode-terminal";
import logger, { sanitizeLevel } from "./utils/logger.js";
import type { BoomError } from "./types/ErrorTypes.js";
import { addMembersToGroups, type AddSummary } from "./core/addTask.js";
import { removeMembersFromGroups, type RemoveSummary } from "./core/removeTask.js";
import { scanGroups } from "./core/scanTask.js";
import { getPhoneNumbersWithStatus, saveGroupsToList } from "./db/pgsql.js";
import { preprocessPhoneNumbers } from "./utils/phoneCheck.js";
import { delaySecs } from "./utils/delay.js";
import { Command } from "commander";
import { processGroupsBaileys } from "./utils/groups.js";
import type { MinimalGroup } from "./utils/groups.js";
import { ensureTwilioClientReadyOrExit } from "./utils/twilio.js";
import { checkPhoneNumber } from "./utils/phoneCheck.js";
import { isOrgMBGroup } from "./utils/checkGroupType.js";
import { buildAllowedGroups, createMessageProcessor } from "./core/messagesTask.js";
import { MessageStore } from "./store/messageStore.js";
import { getQueueLength } from "./db/redis.js";
import { writeFile } from "fs/promises";

configDotenv({ path: ".env" });

async function main() {
  // CLI options
  const program = new Command();
  program
    .option("--add", "Run add task")
    .option("--remove", "Run remove task")
    .option("--scan", "Run scan task (group membership tracking)")
    .option("--community", "Restrict removals to community and announce groups only")
    .option("--comunity", "Alias for --community");
  program.parse(process.argv);
  const opts = program.opts<{
    add?: boolean;
    remove?: boolean;
    scan?: boolean;
    community?: boolean;
    comunity?: boolean;
  }>();

  const communityMode = Boolean(opts.community ?? opts.comunity);
  const tasksSpecified = Boolean(opts.add || opts.remove || opts.scan);
  const runAdd = tasksSpecified ? Boolean(opts.add) : true;
  const runRemove = tasksSpecified ? Boolean(opts.remove || communityMode) : true;
  const runScan = tasksSpecified ? Boolean(opts.scan) : true;

  logger.info(
    {
      runAdd,
      runRemove,
      runScan,
      communityMode,
      removalScope: communityMode ? "community-only" : "all-admin",
    },
    "Task configuration resolved",
  );

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

  const enableFullHistory = process.env.WPP_SYNC_FULL_HISTORY === "true";
  const messageStore = await MessageStore.create({ filePath: process.env.MESSAGE_STORE_PATH });
  let sock: WASocket;

  let lastQR: string | undefined;

  // Orchestration: run tasks once per cycle (seconds only)
  const cycleDelaySeconds = Math.max(1, Math.floor(Number(process.env.CYCLE_DELAY_SECONDS ?? 1800)));
  const cycleJitterSeconds = Math.max(0, Math.floor(Number(process.env.CYCLE_JITTER_SECONDS ?? 0)));
  let loopStarted = false;
  let isConnected = false;
  let isCycleRunning = false;
  let pendingImmediateRunOnOpen = false;

  let messageProcessor: ReturnType<typeof createMessageProcessor> | undefined;
  let _latestAllowedGroupsForMessages: MinimalGroup[] | undefined;

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
      const { groups, adminGroups, community, communityAnnounce, adminCommunity, adminCommunityAnnounce } =
        await processGroupsBaileys(sock);
      // Filter out OrgMB groups only (keep all others) and then apply Mensa classification for message history
      const adminNonOrg = adminGroups.filter((g) => !isOrgMBGroup(g.subject ?? g.name ?? ""));
      const mensaAdminGroups = adminNonOrg;
      const removalAdminGroups = adminGroups;
      const removalCommunityGroups = adminCommunity;
      const removalCommunityAnnounceGroups = adminCommunityAnnounce;
      const removalGroups = communityMode
        ? [...removalCommunityGroups, ...removalCommunityAnnounceGroups]
        : [...removalAdminGroups, ...removalCommunityGroups, ...removalCommunityAnnounceGroups];

      // Build allowed groups for message sync (Mensa groups except OrgMB)
      try {
        const allowedGroups = await buildAllowedGroups(adminNonOrg);
        _latestAllowedGroupsForMessages = adminNonOrg;
        messageProcessor = createMessageProcessor(sock, allowedGroups, {
          filterByLastTimestamp: true,
          dbBatchSize: Math.max(1, Number(process.env.WPP_MSG_DB_BATCH ?? 200)),
        });
      } catch (err) {
        logger.warn({ err }, "Failed to build message processor allowed groups");
      }
      // Update DB with current groups list (OrgMB already excluded)
      try {
        const toSave = mensaAdminGroups.map((g) => ({ group_id: g.id, group_name: g.subject ?? g.name ?? g.id }));
        await saveGroupsToList(toSave);
      } catch (err) {
        logger.warn({ err }, "Failed to save groups list to DB");
      }

      // 1) Add task (id + name/subject)
      let addSummary: AddSummary | undefined;
      if (runAdd) {
        const addTaskGroups = mensaAdminGroups.map((g) => ({ id: g.id, subject: g.subject, name: g.name }));
        addSummary = await addMembersToGroups(addTaskGroups);
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
      let removeSummary: RemoveSummary | undefined;
      if (runRemove && phoneMap) {
        removeSummary = await removeMembersFromGroups(removalGroups, phoneMap);
      }

      if (runRemove && (runScan || false)) {
        await delaySecs(actionDelayMin, actionDelayMax, actionDelayJitter);
      }

      // 4) Scan task
      if (runScan && phoneMap) {
        const sendSeen = async (groupId: string) => {
          try {
            const last = messageStore.getLastKeyForGroup(groupId);
            if (!last) return;
            await sock.readMessages([
              {
                remoteJid: groupId,
                id: last.id,
                fromMe: false,
                participant: last.participant ?? undefined,
              },
            ]);
            logger.debug({ groupId, id: last.id }, "Sent seen for last message in group");
          } catch (err) {
            logger.debug({ err, groupId }, "Failed to send seen for group (non-fatal)");
          }
        };
        await scanGroups(mensaAdminGroups, phoneMap, { sendSeen });
      }

      // End-of-cycle summary (stdout with colors)
      try {
        const totalGroupsAll = groups.length + community.length + communityAnnounce.length;
        const notAdminCount = Math.max(0, groups.length - adminGroups.length);
        const removalGroupsProcessed = runRemove ? removalGroups.length : 0;
        const addQueueLength = await getQueueLength("addQueue");
        const removeQueueLength = await getQueueLength("removeQueue");

        const details = {
          totalGroupsAll,
          nonCommunityGroups: groups.length,
          adminGroupsProcessed: mensaAdminGroups.length,
          removalGroupsProcessed,
          notAdminCount,
          addSummary,
          removeSummary,
          queues: { addQueueLength, removeQueueLength },
        };

        // Render console summary
        // Header
        logger.info("\n\x1b[1m=== REMOVAL REPORT SUMMARY ===\x1b[0m");
        // High-level counts
        logger.info(`\x1b[36mTotal groups: ${totalGroupsAll}\x1b[0m`);
        logger.info(`\x1b[36mTotal groups processed (add/scan): ${mensaAdminGroups.length}\x1b[0m`);
        logger.info(`\x1b[36mTotal groups processed for removal (incl. community): ${removalGroupsProcessed}\x1b[0m`);
        logger.info(`\x1b[31mBot is not admin in: ${notAdminCount} groups\x1b[0m\n`);

        // Members by issue

        logger.info("\x1b[1mMember Count by Issue:\x1b[0m");
        if (removeSummary) {
          logger.info(`\x1b[33m• Total unique members affected: ${removeSummary.uniqueMembersAffected}`);

          logger.info(
            `• Inactive status: ${removeSummary.atleast1inactiveCount} members (${removeSummary.totalInactiveCount} total occurrences)`,
          );

          logger.info(
            `• Not in database: ${removeSummary.atleast1notfoundCount} members (${removeSummary.totalNotFoundCount} total occurrences)`,
          );

          logger.info(
            `• JB over 10 in M.JB: ${removeSummary.atleast1JBOver10MJBCount} members (${removeSummary.totalJBOver10MJBCount} total occurrences)`,
          );

          logger.info(
            `• JB under 10 in JB: ${removeSummary.atleast1JBUnder10JBCount} members (${removeSummary.totalJBUnder10JBCount} total occurrences)`,
          );
          logger.info(
            `• Adult not legal representative in R.JB: ${removeSummary.atleast1NonLegalRepCount} members (${removeSummary.totalNonLegalRepCount} total occurrences)`,
          );
          logger.info(
            `• Legal rep no longer represents a minor (18+): ${removeSummary.atleast1NoLongerRepMinorCount} members (${removeSummary.totalNoLongerRepMinorCount} total occurrences)`,
          );
          logger.info(
            `• Children without matching legal rep phones in R.JB: ${removeSummary.atleast1ChildPhoneMismatchCount} members (${removeSummary.totalChildPhoneMismatchCount} total occurrences)`,
          );
          logger.info(
            `• JB in non-JB: ${removeSummary.atleast1JBInNonJBCount} members (${removeSummary.totalJBInNonJBCount} total occurrences)\x1b[0m\n`,
          );
        } else {
          logger.info("• No removals evaluated this cycle.\x1b[0m\n");
        }

        // Pending additions

        logger.info("\x1b[1mPending Additions:\x1b[0m");
        if (addSummary) {
          logger.info(`\x1b[32m• Members awaiting addition: ${addSummary.atleast1PendingAdditionsCount}`);
          logger.info(`• Total pending additions: ${addSummary.totalPendingAdditionsCount}\x1b[0m\n`);
        } else {
          logger.info("\x1b[32m• Add task disabled this cycle\x1b[0m\n");
        }

        // Special numbers
        const dontRemoveList = (process.env.DONT_REMOVE_NUMBERS ?? "").split(",").filter(Boolean);
        const exceptionsList = (process.env.EXCEPTIONS ?? "").split(",").filter(Boolean);

        logger.info("\x1b[1mSpecial Numbers:\x1b[0m");
        if (removeSummary) {
          logger.info(
            `\x1b[35m• Don't Remove list: ${dontRemoveList.length} numbers (${removeSummary.dontRemoveInGroupsCount} total occurrences)`,
          );

          logger.info(
            `• Exception list: ${exceptionsList.length} numbers (${removeSummary.exceptionsInGroupsCount} total occurrences)\x1b[0m\n`,
          );
        } else {
          logger.info(`\x1b[35m• Don't Remove list: ${dontRemoveList.length} numbers (0 total occurrences)`);

          logger.info(`• Exception list: ${exceptionsList.length} numbers (0 total occurrences)\x1b[0m\n`);
        }

        // Queues

        logger.info("\x1b[1mTotal items in queue:\x1b[0m");

        logger.info(`\x1b[32m• Add Queue: ${addQueueLength}`);

        logger.info(`• Remove Queue: ${removeQueueLength}\x1b[0m`);

        // Save details JSON (best-effort)
        try {
          await writeFile("report_details.json", JSON.stringify(details, null, 2), "utf8");

          logger.info("\x1b[1mDetailed report saved to:\x1b[0m \x1b[36mreport_details.json\x1b[0m");
        } catch (err) {
          logger.warn({ err }, "Error writing report details to file");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to print cycle report summary");
      }

      try {
        const uptimeUrl = process.env.UPTIME_URL;
        if (uptimeUrl) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30_000);
          try {
            await fetch(uptimeUrl, { signal: controller.signal });
          } finally {
            clearTimeout(timeoutId);
          }
        }
      } catch (err) {
        logger.warn({ err }, "Uptime check failed");
      }
    } catch (err) {
      const code = (err as BoomError)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        logger.fatal({ err }, "Session logged out during cycle; exiting");
        process.exit(1);
      }
      const message = (err as BoomError)?.output?.payload?.message;
      if (message === "Connection Closed" || code === 428) {
        logger.fatal({ err }, "Closed connection detected during cycle; exiting");
        process.exit(1);
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

  // Reconnection controls
  let reconnectAttempts = 0;
  const maxReconnectAttempts = Math.max(1, Number(process.env.MAX_RECONNECT_ATTEMPTS ?? 5));
  const maxBackoffMs = Math.max(1000, Number(process.env.MAX_RECONNECT_BACKOFF_MS ?? 30000));

  async function initSocket() {
    sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.macOS("Desktop"),
      logger: logger.child({ module: "baileys" }, { level: sanitizeLevel(process.env.BAILEYS_LOG_LEVEL, "fatal") }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: enableFullHistory,
      getMessage: async (key) => messageStore.getMessage({ id: key.id }),
    });

    bindSocketEvents(sock);
  }

  function bindSocketEvents(s: WASocket) {
    s.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      if (qr) {
        if (qr !== lastQR) {
          lastQR = qr;
          qrcode.generate(qr, { small: true });
          logger.info("Scan the QR code in WhatsApp > Connected devices");
        }
      }

      if (connection === "open") {
        isConnected = true;
        reconnectAttempts = 0;
        logger.info("[wa] connection opened.");
        // Start the orchestrator loop once after connection is open
        if (!loopStarted) {
          startLoop().catch((err) => logger.error({ err }, "Loop start error"));
        } else if (pendingImmediateRunOnOpen && !isCycleRunning) {
          pendingImmediateRunOnOpen = false;
          // Trigger an immediate cycle after reconnect
          runCycleOnce().catch((err) => logger.error({ err }, "Immediate run after reconnect failed"));
        }
        return;
      }

      if (connection === "close") {
        isConnected = false;
        const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
        const isLoggedOut = code === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          logger.fatal({ code }, "[wa] connection closed: Session logged out. Delete ./auth and link again.");
          process.exit(1);
        }

        reconnectAttempts += 1;
        if (reconnectAttempts > maxReconnectAttempts) {
          logger.fatal({ attempts: reconnectAttempts }, "Exceeded max reconnect attempts; exiting");
          process.exit(1);
        }

        const backoff = Math.min(maxBackoffMs, 1000 * Math.pow(2, reconnectAttempts - 1));
        logger.warn({ code, attempt: reconnectAttempts, backoff }, "[wa] connection closed; reinitializing socket...");

        setTimeout(() => {
          // Mark to run immediately once connection is restored
          pendingImmediateRunOnOpen = true;
          initSocket().catch((err) => {
            logger.error({ err }, "Socket re-init failed");
          });
        }, backoff);
      }
    });

    s.ev.on("creds.update", saveCreds);

    // Handle message history & live messages
    s.ev.on("messaging-history.set", async ({ messages, progress, isLatest, syncType }) => {
      try {
        if (!messageProcessor) return;
        const count = await messageProcessor.processMessages(messages);
        // Update local message store (id + last per group)
        messageStore.updateFromMessages(messages);
        logger.info(
          { received: messages.length, inserted: count, progress, isLatest, syncType },
          "Processed history messages batch",
        );
      } catch (err) {
        logger.error({ err }, "Failed processing messaging-history.set");
      }
    });

    s.ev.on("messages.upsert", async ({ messages, type }) => {
      try {
        if (!messageProcessor) return;
        const count = await messageProcessor.processMessages(messages);
        // Update local message store
        messageStore.updateFromMessages(messages);
        // Mark all new incoming (not from me) messages as read
        try {
          const keys: WAMessageKey[] = [];
          for (const m of messages) {
            const id = m.key.id;
            const jid = m.key.remoteJid;
            if (!id || !jid) continue;
            if (m.key.fromMe) continue;
            keys.push({ id, remoteJid: jid, fromMe: false, participant: m.key.participant ?? undefined });
          }
          if (keys.length) {
            await s.readMessages(keys);
            logger.debug({ count: keys.length }, "Marked new messages as read");
          }
        } catch (err) {
          logger.debug({ err }, "Failed to mark new messages as read (non-fatal)");
        }
        logger.debug({ received: messages.length, inserted: count, type }, "Processed live messages upsert");
      } catch (err) {
        logger.error({ err }, "Failed processing messages.upsert");
      }
    });
  }

  // initialize first socket
  await initSocket();

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
