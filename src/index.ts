import { config as configDotenv } from "dotenv";
import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers, useMultiFileAuthState } from "baileys";
import type { WASocket } from "baileys";
import qrcode from "qrcode-terminal";
import logger, { sanitizeLevel } from "./utils/logger.js";
import type { BoomError } from "./types/ErrorTypes.js";
import { addMembersToGroups, type AddSummary } from "./core/addTask.js";
import { removeMembersFromGroups, type RemoveSummary } from "./core/removeTask.js";
import { scanGroups } from "./core/scanTask.js";
import { getActiveWhatsappPolicy, getPhoneNumbersWithStatus, saveGroupsToList, upsertLidMapping } from "./db/pgsql.js";
import { preprocessPhoneNumbers } from "./utils/phoneCheck.js";
import { delaySecs } from "./utils/delay.js";
import { Command } from "commander";
import { processGroupsBaileys } from "./utils/groups.js";
import type { ResolveLidToPhoneFn } from "./utils/jid.js";
import { checkGroupType } from "./utils/checkGroupType.js";
import { getQueueLength } from "./db/redis.js";
import { writeFile } from "fs/promises";
import { buildProtectedPhoneMatcherFromList, buildSuspendedPhoneMatcherFromList } from "./utils/phoneList.js";
import { runStartupPreflight } from "./startup/preflight.js";
import { getAuthStateDir } from "./baileys/auth-state-dir.js";

configDotenv({ path: ".env" });

async function main() {
  // CLI options
  const program = new Command();
  program
    .option("--add", "Run add task")
    .option("--remove", "Run remove task")
    .option("--scan", "Run scan task (group membership tracking)")
    .option("--community", "Restrict removals to community and announce groups only")
    .option("--comunity", "Alias for --community")
    .option("--pairing", "Use pairing code for login (requires PAIRING_PHONE env var)");
  program.parse(process.argv);
  const opts = program.opts<{
    add?: boolean;
    remove?: boolean;
    scan?: boolean;
    community?: boolean;
    comunity?: boolean;
    pairing?: boolean;
  }>();

  const communityMode = Boolean(opts.community ?? opts.comunity);
  const tasksSpecified = Boolean(opts.add || opts.remove || opts.scan);
  const runAdd = tasksSpecified ? Boolean(opts.add) : true;
  const runRemove = tasksSpecified ? Boolean(opts.remove || communityMode) : true;
  const runScan = tasksSpecified ? Boolean(opts.scan) : true;
  const pairingCodeMode = Boolean(opts.pairing);

  logger.info(
    {
      runAdd,
      runRemove,
      runScan,
      communityMode,
      removalScope: communityMode ? "community-only" : "all-admin",
      authMethod: pairingCodeMode ? "pairing" : "qr",
    },
    "Task configuration resolved",
  );

  await runStartupPreflight();

  const actionDelayMin = Number(process.env.ACTION_DELAY_MIN ?? 1);
  const actionDelayMax = Number(process.env.ACTION_DELAY_MAX ?? 3);
  const actionDelayJitter = Number(process.env.ACTION_DELAY_JITTER ?? 0.5);

  const { state, saveCreds } = await useMultiFileAuthState(getAuthStateDir());
  const { version } = await fetchLatestBaileysVersion();

  let sock: WASocket;

  const lidResolver: ResolveLidToPhoneFn = async (lid) =>
    (await sock?.signalRepository?.lidMapping?.getPNForLID(lid)) ?? null;

  async function persistLidMapping(lid: string, phone: string, source: string): Promise<void> {
    try {
      if (sock?.signalRepository?.lidMapping) {
        await sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn: phone }]);
      }
    } catch (err) {
      logger.debug({ err, lid }, "Failed to store LID mapping in memory store");
    }
    try {
      await upsertLidMapping(lid, phone, source);
    } catch (err) {
      logger.warn({ err, lid }, "Failed to persist LID mapping to DB (ensure whatsapp_lid_mappings exists)");
    }
  }

  let lastQR: string | undefined;
  let pairingCodeRequested = false;

  async function requestPairingCodeIfNeeded(s: WASocket): Promise<void> {
    if (!pairingCodeMode) return;
    if (pairingCodeRequested) return;
    if (s.authState.creds.registered) return;

    const phoneNumber = (process.env.PAIRING_PHONE ?? "").replace(/\D/g, "");
    if (!phoneNumber) {
      throw new Error("Defina a env PAIRING_PHONE (ex: 5511999999999) para usar --pairing.");
    }

    try {
      await s.waitForConnectionUpdate((u) => Promise.resolve(!!u.qr || u.connection === "open"));
      const code = await s.requestPairingCode(phoneNumber);
      pairingCodeRequested = true;
      logger.warn(
        { code },
        "Pairing code gerado; entre em WhatsApp > Conectados > Adicionar dispositivo e insira o código.",
      );
    } catch (err) {
      pairingCodeRequested = false;
      logger.error({ err }, "Falha ao gerar pairing code");
      throw err;
    }
  }

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
      const { groups, adminGroups, community, communityAnnounce, adminCommunity, adminCommunityAnnounce } =
        await processGroupsBaileys(sock);
      const managedAdminGroups = [];
      for (const group of adminGroups) {
        const groupType = await checkGroupType(group.subject ?? group.name ?? "");
        if (groupType) managedAdminGroups.push(group);
      }
      const removalAdminGroups = adminGroups;
      const removalCommunityGroups = adminCommunity;
      const removalCommunityAnnounceGroups = adminCommunityAnnounce;
      const removalGroups = communityMode
        ? [...removalCommunityGroups, ...removalCommunityAnnounceGroups]
        : [...removalAdminGroups, ...removalCommunityGroups, ...removalCommunityAnnounceGroups];
      // Update DB with current managed groups list.
      try {
        const toSave = managedAdminGroups.map((g) => ({ group_id: g.id, group_name: g.subject ?? g.name ?? g.id }));
        await saveGroupsToList(toSave);
      } catch (err) {
        logger.warn({ err }, "Failed to save groups list to DB");
      }

      const activePolicy = await getActiveWhatsappPolicy();
      const isInvitedPhone = buildProtectedPhoneMatcherFromList(activePolicy.invitedPhones);
      const isSuspendedPhone = buildSuspendedPhoneMatcherFromList(activePolicy.suspendedPhones);

      // 1) Add task (id + name/subject)
      let addSummary: AddSummary | undefined;
      if (runAdd) {
        const addTaskGroups = managedAdminGroups.map((g) => ({ id: g.id, subject: g.subject, name: g.name }));
        addSummary = await addMembersToGroups(addTaskGroups, {
          suspendedRegistrationIds: new Set(activePolicy.suspendedRegistrationIds),
        });
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
        removeSummary = await removeMembersFromGroups(removalGroups, phoneMap, {
          resolveLidToPhone: lidResolver,
          policy: { isInvitedPhone, isSuspendedPhone },
        });
      }

      if (runRemove && (runScan || false)) {
        await delaySecs(actionDelayMin, actionDelayMax, actionDelayJitter);
      }

      // 4) Scan task
      if (runScan && phoneMap) {
        await scanGroups(managedAdminGroups, phoneMap, {
          resolveLidToPhone: lidResolver,
          policy: { isInvitedPhone },
        });
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
          adminGroupsProcessed: managedAdminGroups.length,
          removalGroupsProcessed,
          notAdminCount,
          addSummary,
          removeSummary,
          policyCounts: {
            invitedPhones: activePolicy.invitedPhones.length,
            suspendedPhones: activePolicy.suspendedPhones.length,
            suspendedRegistrationIds: activePolicy.suspendedRegistrationIds.length,
          },
          queues: { addQueueLength, removeQueueLength },
        };

        // Render console summary
        // Header
        logger.info("\n\x1b[1m=== REMOVAL REPORT SUMMARY ===\x1b[0m");
        // High-level counts
        logger.info(`\x1b[36mTotal groups: ${totalGroupsAll}\x1b[0m`);
        logger.info(`\x1b[36mTotal groups processed (add/scan): ${managedAdminGroups.length}\x1b[0m`);
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
            `• Not eligible for MB: ${removeSummary.atleast1IneligibleMBCount} members (${removeSummary.totalIneligibleMBCount} total occurrences)`,
          );
          logger.info(
            `• Not eligible for RJB: ${removeSummary.atleast1IneligibleRJBCount} members (${removeSummary.totalIneligibleRJBCount} total occurrences)\x1b[0m\n`,
          );

          if (removeSummary.removalReasons.length > 0) {
            logger.info("\x1b[1mSpecific Removal Reasons:\x1b[0m");
            for (const item of removeSummary.removalReasons) {
              logger.info(
                `• ${item.reason}: ${item.uniqueMembers} members (${item.totalOccurrences} total occurrences)`,
              );
            }
            logger.info("");
          }
        } else {
          logger.info("• No removals evaluated this cycle.\x1b[0m\n");
        }

        // Pending additions

        logger.info("\x1b[1mPending Additions:\x1b[0m");
        if (addSummary) {
          logger.info(`\x1b[32m• Members awaiting addition: ${addSummary.atleast1PendingAdditionsCount}`);
          logger.info(`• Total pending additions: ${addSummary.totalPendingAdditionsCount}\x1b[0m\n`);
          if (addSummary.ignoredRegistrationsCount > 0) {
            logger.info(
              `\x1b[33m• Ignored by env config: ${addSummary.ignoredRegistrationsCount} members (${addSummary.ignoredRequestsCount} requests skipped)\x1b[0m`,
            );
          }
          if (addSummary.suspendedRegistrationsCount > 0) {
            logger.info(
              `\x1b[33m• Blocked by suspended policy: ${addSummary.suspendedRegistrationsCount} members (${addSummary.suspendedRequestsCount} requests skipped)\x1b[0m\n`,
            );
          }
        } else {
          logger.info("\x1b[32m• Add task disabled this cycle\x1b[0m\n");
        }

        // Special numbers
        logger.info("\x1b[1mSpecial Numbers:\x1b[0m");
        if (removeSummary) {
          logger.info(
            `\x1b[35m• Invited list: ${activePolicy.invitedPhones.length} numbers (${removeSummary.invitedInGroupsCount} total occurrences)`,
          );
          logger.info(
            `• Suspended list: ${activePolicy.suspendedPhones.length} numbers (${removeSummary.suspendedInGroupsCount} total occurrences)\x1b[0m\n`,
          );
        } else {
          logger.info(`\x1b[35m• Invited list: ${activePolicy.invitedPhones.length} numbers (0 total occurrences)`);
          logger.info(
            `• Suspended list: ${activePolicy.suspendedPhones.length} numbers (0 total occurrences)\x1b[0m\n`,
          );
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
    });

    await requestPairingCodeIfNeeded(sock);
    bindSocketEvents(sock);
  }

  function bindSocketEvents(s: WASocket) {
    s.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
      if (qr && !pairingCodeMode) {
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
          logger.fatal(
            { code },
            "[wa] connection closed: Session logged out. Delete the local auth folder and link again.",
          );
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

    s.ev.on("lid-mapping.update", async (updates) => {
      try {
        const list = Array.isArray(updates) ? updates : [updates];
        for (const item of list) {
          const lid = (item as { lid?: string; id?: string }).lid ?? (item as { id?: string }).id;
          const phone =
            (item as { pn?: string; phoneNumber?: string }).pn ?? (item as { phoneNumber?: string }).phoneNumber;
          if (lid && phone) {
            await persistLidMapping(lid, phone, "lid-mapping.update");
          }
        }
      } catch (err) {
        logger.debug({ err }, "Failed to handle lid-mapping.update event (non-fatal)");
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
