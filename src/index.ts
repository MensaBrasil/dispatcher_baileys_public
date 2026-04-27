import { writeFile } from "node:fs/promises";
import type { WASocket } from "baileys";
import { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeWASocket, useMultiFileAuthState } from "baileys";
import { Command } from "commander";
import { config as configDotenv } from "dotenv";
import qrcode from "qrcode-terminal";
import { getAuthStateDir } from "./baileys/auth-state-dir.js";
import { type AddSummary, addMembersToGroups } from "./core/addTask.js";
import { type RemoveSummary, removeMembersFromGroups } from "./core/removeTask.js";
import { scanGroups } from "./core/scanTask.js";
import { getActiveWhatsappPolicy, getPhoneNumbersWithStatus, saveGroupsToList, upsertLidMapping } from "./db/pgsql.js";
import { getQueueLength } from "./db/redis.js";
import { runStartupPreflight } from "./startup/preflight.js";
import type { BoomError } from "./types/ErrorTypes.js";
import { checkGroupType } from "./utils/checkGroupType.js";
import { delaySecs } from "./utils/delay.js";
import { processGroupsBaileys } from "./utils/groups.js";
import type { ResolveLidToPhoneFn } from "./utils/jid.js";
import logger, { sanitizeLevel } from "./utils/logger.js";
import { preprocessPhoneNumbers } from "./utils/phoneCheck.js";
import { buildProtectedPhoneMatcherFromList, buildSuspendedPhoneMatcherFromList } from "./utils/phoneList.js";

configDotenv({ path: ".env" });

async function main() {
  // CLI options
  const program = new Command();
  program
    .option("--add", "Executa a tarefa de adição")
    .option("--remove", "Executa a tarefa de remoção")
    .option("--scan", "Executa a tarefa de scan (rastreamento de membros dos grupos)")
    .option("--community", "Restringe remoções apenas a comunidades e grupos de avisos")
    .option("--comunity", "Apelido para --community")
    .option("--pairing", "Usa código de pareamento para login (exige a env PAIRING_PHONE)");
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
  const runScan = tasksSpecified ? Boolean(opts.scan || opts.add || opts.remove || communityMode) : true;
  const pairingCodeMode = Boolean(opts.pairing);

  logger.info(
    {
      runAdd,
      runRemove,
      runScan,
      communityMode,
      removalScope: communityMode ? "apenas-comunidade" : "todos-admin",
      authMethod: pairingCodeMode ? "pairing" : "qr",
    },
    "Configuração de tarefas resolvida",
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
      logger.debug({ err, lid }, "Falha ao armazenar mapeamento LID na memória");
    }
    try {
      await upsertLidMapping(lid, phone, source);
    } catch (err) {
      logger.warn({ err, lid }, "Falha ao persistir mapeamento LID no banco (confira se whatsapp_lid_mappings existe)");
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
        "Código de pareamento gerado; entre em WhatsApp > Conectados > Adicionar dispositivo e insira o código.",
      );
    } catch (err) {
      pairingCodeRequested = false;
      logger.error({ err }, "Falha ao gerar código de pareamento");
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
        logger.warn("[wa] não conectado; pulando execução do ciclo");
        return;
      }
      if (isCycleRunning) {
        logger.warn("Ciclo já em execução; pulando execução sobreposta");
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
        logger.warn({ err }, "Falha ao salvar lista de grupos no banco");
      }

      const activePolicy = await getActiveWhatsappPolicy();
      const isInvitedPhone = buildProtectedPhoneMatcherFromList(activePolicy.invitedPhones);
      const isSuspendedPhone = buildSuspendedPhoneMatcherFromList(activePolicy.suspendedPhones);

      // 1) Build phone map if needed for scan/remove
      let phoneMap: ReturnType<typeof preprocessPhoneNumbers> | undefined;
      if (runRemove || runScan) {
        const phoneRows = await getPhoneNumbersWithStatus();
        phoneMap = preprocessPhoneNumbers(phoneRows);
      }

      // 2) Scan task always runs first so add/remove use the freshest group state.
      if (runScan && phoneMap) {
        await scanGroups(managedAdminGroups, phoneMap, {
          resolveLidToPhone: lidResolver,
          policy: { isInvitedPhone },
        });
      }

      if (runScan && (runRemove || runAdd)) {
        await delaySecs(actionDelayMin, actionDelayMax, actionDelayJitter);
      }

      // 3) Remove task
      let removeSummary: RemoveSummary | undefined;
      if (runRemove && phoneMap) {
        removeSummary = await removeMembersFromGroups(removalGroups, phoneMap, {
          resolveLidToPhone: lidResolver,
          policy: { isInvitedPhone, isSuspendedPhone },
        });
      }

      if (runRemove && runAdd) {
        await delaySecs(actionDelayMin, actionDelayMax, actionDelayJitter);
      }

      // 4) Add task (id + name/subject)
      let addSummary: AddSummary | undefined;
      if (runAdd) {
        const addTaskGroups = managedAdminGroups.map((g) => ({ id: g.id, subject: g.subject, name: g.name }));
        addSummary = await addMembersToGroups(addTaskGroups, {
          suspendedRegistrationIds: new Set(activePolicy.suspendedRegistrationIds),
          suspendedPhones: activePolicy.suspendedPhones,
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
        logger.info("\n\x1b[1m=== RESUMO DO RELATÓRIO DE REMOÇÃO ===\x1b[0m");
        // High-level counts
        logger.info(`\x1b[36mTotal de grupos: ${totalGroupsAll}\x1b[0m`);
        logger.info(`\x1b[36mTotal de grupos processados (adição/escaneamento): ${managedAdminGroups.length}\x1b[0m`);
        logger.info(
          `\x1b[36mTotal de grupos processados para remoção (incluindo comunidade): ${removalGroupsProcessed}\x1b[0m`,
        );
        logger.info(`\x1b[31mBot não é admin em: ${notAdminCount} grupos\x1b[0m\n`);

        // Members by issue

        logger.info("\x1b[1mContagem de membros por problema:\x1b[0m");
        if (removeSummary) {
          logger.info(`\x1b[33m• Total de membros únicos afetados: ${removeSummary.uniqueMembersAffected}`);

          logger.info(
            `• Status inativo: ${removeSummary.atleast1inactiveCount} membros (${removeSummary.totalInactiveCount} ocorrências totais)`,
          );

          logger.info(
            `• Não encontrados no banco: ${removeSummary.atleast1notfoundCount} membros (${removeSummary.totalNotFoundCount} ocorrências totais)`,
          );

          logger.info(
            `• Não elegíveis para MB: ${removeSummary.atleast1IneligibleMBCount} membros (${removeSummary.totalIneligibleMBCount} ocorrências totais)`,
          );
          logger.info(
            `• Não elegíveis para RJB: ${removeSummary.atleast1IneligibleRJBCount} membros (${removeSummary.totalIneligibleRJBCount} ocorrências totais)\x1b[0m\n`,
          );

          if (removeSummary.removalReasons.length > 0) {
            logger.info("\x1b[1mMotivos específicos de remoção:\x1b[0m");
            for (const item of removeSummary.removalReasons) {
              logger.info(
                `• ${item.reason}: ${item.uniqueMembers} membros (${item.totalOccurrences} ocorrências totais)`,
              );
            }
            logger.info("");
          }
        } else {
          logger.info("• Nenhuma remoção avaliada neste ciclo.\x1b[0m\n");
        }

        // Pending additions

        logger.info("\x1b[1mAdições pendentes:\x1b[0m");
        if (addSummary) {
          logger.info(`\x1b[32m• Membros aguardando adição: ${addSummary.atleast1PendingAdditionsCount}`);
          logger.info(`• Total de adições pendentes: ${addSummary.totalPendingAdditionsCount}\x1b[0m\n`);
          if (addSummary.ignoredRegistrationsCount > 0) {
            logger.info(
              `\x1b[33m• Ignorados por configuração de env: ${addSummary.ignoredRegistrationsCount} membros (${addSummary.ignoredRequestsCount} solicitações puladas)\x1b[0m`,
            );
          }
          if (addSummary.suspendedRegistrationsCount > 0) {
            logger.info(
              `\x1b[33m• Bloqueados pela política de suspensão: ${addSummary.suspendedRegistrationsCount} membros (${addSummary.suspendedRequestsCount} solicitações puladas)\x1b[0m\n`,
            );
          }
        } else {
          logger.info("\x1b[32m• Tarefa de adição desativada neste ciclo\x1b[0m\n");
        }

        // Special numbers
        logger.info("\x1b[1mNúmeros especiais:\x1b[0m");
        if (removeSummary) {
          logger.info(
            `\x1b[35m• Lista de convidados: ${activePolicy.invitedPhones.length} números (${removeSummary.invitedInGroupsCount} ocorrências totais)`,
          );
          logger.info(
            `• Lista de suspensos: ${activePolicy.suspendedPhones.length} números (${removeSummary.suspendedInGroupsCount} ocorrências totais)\x1b[0m\n`,
          );
        } else {
          logger.info(
            `\x1b[35m• Lista de convidados: ${activePolicy.invitedPhones.length} números (0 ocorrências totais)`,
          );
          logger.info(
            `• Lista de suspensos: ${activePolicy.suspendedPhones.length} números (0 ocorrências totais)\x1b[0m\n`,
          );
        }

        // Queues

        logger.info("\x1b[1mTotal de itens na fila:\x1b[0m");

        logger.info(`\x1b[32m• Fila de adição: ${addQueueLength}`);

        logger.info(`• Fila de remoção: ${removeQueueLength}\x1b[0m`);

        // Save details JSON (best-effort)
        try {
          await writeFile("report_details.json", JSON.stringify(details, null, 2), "utf8");

          logger.info("\x1b[1mRelatório detalhado salvo em:\x1b[0m \x1b[36mreport_details.json\x1b[0m");
        } catch (err) {
          logger.warn({ err }, "Erro ao gravar relatório detalhado em arquivo");
        }
      } catch (err) {
        logger.warn({ err }, "Falha ao imprimir resumo do relatório do ciclo");
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
        logger.warn({ err }, "Falha na verificação de uptime");
      }
    } catch (err) {
      const code = (err as BoomError)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        logger.fatal({ err }, "Sessão desconectada durante o ciclo; encerrando");
        process.exit(1);
      }
      const message = (err as BoomError)?.output?.payload?.message;
      if (message === "Connection Closed" || code === 428) {
        logger.fatal({ err }, "Conexão fechada detectada durante o ciclo; encerrando");
        process.exit(1);
      }
      logger.error({ err }, "Erro ao executar tarefas do ciclo");
    } finally {
      isCycleRunning = false;
    }
  }

  async function startLoop() {
    if (loopStarted) return;
    loopStarted = true;
    logger.info(
      { intervalSeconds: cycleDelaySeconds, jitterSeconds: cycleJitterSeconds },
      "Iniciando loop principal (uma execução por intervalo)",
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
          logger.info("Escaneie o QR code no WhatsApp > Dispositivos conectados");
        }
      }

      if (connection === "open") {
        isConnected = true;
        reconnectAttempts = 0;
        logger.info("[wa] conexão aberta.");
        // Start the orchestrator loop once after connection is open
        if (!loopStarted) {
          startLoop().catch((err) => logger.error({ err }, "Erro ao iniciar loop"));
        } else if (pendingImmediateRunOnOpen && !isCycleRunning) {
          pendingImmediateRunOnOpen = false;
          // Trigger an immediate cycle after reconnect
          runCycleOnce().catch((err) => logger.error({ err }, "Execução imediata após reconexão falhou"));
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
            "[wa] conexão fechada: sessão encerrada. Apague a pasta local de autenticação e conecte novamente.",
          );
          process.exit(1);
        }

        reconnectAttempts += 1;
        if (reconnectAttempts > maxReconnectAttempts) {
          logger.fatal({ attempts: reconnectAttempts }, "Limite de tentativas de reconexão excedido; encerrando");
          process.exit(1);
        }

        const backoff = Math.min(maxBackoffMs, 1000 * 2 ** (reconnectAttempts - 1));
        logger.warn({ code, attempt: reconnectAttempts, backoff }, "[wa] conexão fechada; reinicializando conexão...");

        setTimeout(() => {
          // Mark to run immediately once connection is restored
          pendingImmediateRunOnOpen = true;
          initSocket().catch((err) => {
            logger.error({ err }, "Falha ao reinicializar conexão");
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
        logger.debug({ err }, "Falha ao tratar evento lid-mapping.update (não fatal)");
      }
    });
  }

  // initialize first socket
  await initSocket();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Encerrando...");
    setTimeout(() => process.exit(0), 50);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: error }, "Erro não tratado");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Rejeição de promise não tratada");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Exceção não capturada");
  process.exit(1);
});
