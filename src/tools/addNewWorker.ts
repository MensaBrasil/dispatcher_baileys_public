import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  type GroupMetadata,
  type GroupParticipant,
} from "baileys";
import qrcode from "qrcode-terminal";
import fs from "node:fs/promises";
import path from "node:path";
import logger, { sanitizeLevel } from "../utils/logger.js";
import type { BoomError } from "../types/ErrorTypes.js";
import { Command } from "commander";
import { getAllWhatsAppWorkers } from "../db/pgsql.js";
import { delaySecs } from "../utils/delay.js";

configDotenv({ path: ".env" });

type MaybeJidParticipant = GroupParticipant & { jid?: string };

function toDigitsPhone(input: string): string {
  return input.replace(/\D+/g, "");
}

function toJidFromDigits(digits: string): string {
  return `${digits}@s.whatsapp.net`;
}

function isSameUser(p: MaybeJidParticipant, jid: string): boolean {
  const pid = p.id;
  const pjid = p.jid;
  return pid === jid || pjid === jid;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .description(
      "Adiciona um worker em todos os grupos de avisos (announce) de cada comunidade e promove a admin na comunidade",
    )
    .requiredOption("--worker <phone>", "Telefone do worker (apenas dígitos ou com +)")
    .option("--dry-run", "Mostra o que seria feito sem aplicar mudanças", false);
  program.parse(process.argv);
  const opts = program.opts<{ worker: string; dryRun: boolean }>();

  const workerDigits = toDigitsPhone(opts.worker);
  if (!workerDigits || workerDigits.length < 7) {
    logger.fatal({ worker: opts.worker }, "Telefone do worker inválido");
    process.exit(1);
  }
  const workerJid = toJidFromDigits(workerDigits);

  try {
    const rows = await getAllWhatsAppWorkers();
    const exists = rows.some((r) => toDigitsPhone(r.worker_phone) === workerDigits);
    if (!exists) {
      logger.fatal({ worker: workerDigits }, "Worker não encontrado no banco de dados");
      process.exit(1);
    }
  } catch (err) {
    logger.fatal({ err }, "Erro ao verificar worker no banco de dados");
    process.exit(1);
  }

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

  const outDir = path.resolve("tools_results");
  async function ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      void 0;
    }
  }
  await ensureDir(outDir);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      if (qr !== lastQR) {
        lastQR = qr;
        qrcode.generate(qr, { small: true });
        logger.info("Escaneie o QR code no WhatsApp > Dispositivos conectados");
      }
    }

    if (connection === "open") {
      try {
        const all = await sock.groupFetchAllParticipating();
        const values = Object.values(all) as GroupMetadata[];

        const communities = values.filter((g) => Boolean(g.isCommunity));
        const announceGroups = values.filter((g) => Boolean(g.isCommunityAnnounce));

        if (!communities.length) {
          logger.warn("Nenhuma comunidade encontrada. Nada a fazer.");
          setTimeout(() => process.exit(0), 50);
          return;
        }

        let addCount = 0;
        let alreadyMemberAnnounce = 0;

        const meBare = sock.user?.id?.split(":")[0];
        const meFull = meBare ? `${meBare}@s.whatsapp.net` : undefined;

        const communityReports: Array<{
          communityId: string;
          subject?: string;
          myRole: string | null;
          worker: {
            wasMember: boolean;
            addAttempted: boolean;
            addError?: string;
          };
          announce: Array<{
            id: string;
            subject?: string;
            wasMember: boolean;
            action: "already" | "dry-run-add" | "added" | "failed" | "skipped";
            error?: string;
          }>;
        }> = [];

        for (const comm of communities) {
          const parentId = comm.id;
          const announcesForCommunity = announceGroups.filter((g) => g.linkedParent === parentId);

          const meParticipant = (comm.participants ?? []).find((p) =>
            meFull ? isSameUser(p as MaybeJidParticipant, meFull) : false,
          ) as GroupParticipant | undefined;
          const myRole = meParticipant?.admin ?? null;

          const announceEntries: Array<{
            id: string;
            subject?: string;
            wasMember: boolean;
            action: "already" | "dry-run-add" | "added" | "failed" | "skipped";
            error?: string;
          }> = [];

          const canManageCommunity = myRole === "admin" || myRole === "superadmin";
          for (const ag of announcesForCommunity) {
            const meInAnn = (ag.participants ?? []).find((p) =>
              meFull ? isSameUser(p as MaybeJidParticipant, meFull) : false,
            ) as GroupParticipant | undefined;
            const canManageAnnounce = (meInAnn?.admin ?? null) === "admin" || (meInAnn?.admin ?? null) === "superadmin";

            const workerPart = (ag.participants ?? []).find((p) => isSameUser(p as MaybeJidParticipant, workerJid)) as
              | GroupParticipant
              | undefined;
            const isMember = Boolean(workerPart);
            if (isMember) {
              alreadyMemberAnnounce += 1;
              announceEntries.push({ id: ag.id, subject: ag.subject, wasMember: true, action: "already" });
            } else if (opts.dryRun) {
              logger.info({ announceId: ag.id }, `[dry-run] Adicionaria ${workerJid} no grupo de avisos`);
              announceEntries.push({ id: ag.id, subject: ag.subject, wasMember: false, action: "dry-run-add" });
            } else if (canManageAnnounce || canManageCommunity) {
              try {
                await sock.groupParticipantsUpdate(ag.id, [workerJid], "add");
                addCount += 1;
                logger.info({ announceId: ag.id }, `Adicionado ${workerJid} ao grupo de avisos`);
                await delaySecs(0, 120);
                announceEntries.push({ id: ag.id, subject: ag.subject, wasMember: false, action: "added" });
              } catch (err) {
                logger.error({ err, announceId: ag.id }, "Falha ao adicionar worker no grupo de avisos");
                announceEntries.push({
                  id: ag.id,
                  subject: ag.subject,
                  wasMember: false,
                  action: "failed",
                  error: (err as Error)?.message ?? String(err),
                });
              }
            } else {
              logger.warn({ announceId: ag.id, myRole }, "Sem permissão para adicionar no grupo de avisos; pulando");
              announceEntries.push({ id: ag.id, subject: ag.subject, wasMember: false, action: "skipped" });
            }
          }

          const isMemberInCommunity = (comm.participants ?? []).some((p) =>
            isSameUser(p as MaybeJidParticipant, workerJid),
          );
          communityReports.push({
            communityId: comm.id,
            subject: comm.subject,
            myRole,
            worker: { wasMember: isMemberInCommunity, addAttempted: false },
            announce: announceEntries,
          });
        }

        logger.info(
          {
            worker: workerJid,
            communities: communities.length,
            announceGroups: announceGroups.length,
            addedInAnnounce: addCount,
            alreadyMemberAnnounce,
            dryRun: opts.dryRun,
          },
          "Resumo da execução",
        );

        try {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const outPath = path.join(outDir, `add_worker_${workerDigits}_${ts}.json`);
          const report = {
            worker: { digits: workerDigits, jid: workerJid },
            timestamp: new Date().toISOString(),
            totals: {
              communities: communities.length,
              announceGroups: announceGroups.length,
              addedInAnnounce: addCount,
              alreadyMemberAnnounce,
              dryRun: opts.dryRun,
            },
            entries: communityReports,
          };
          await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
          logger.info({ outPath }, "Relatório detalhado salvo em tools_results");
        } catch (err) {
          logger.warn({ err }, "Falha ao salvar relatório detalhado em tools_results");
        }

        setTimeout(() => process.exit(0), 50);
      } catch (err) {
        logger.error({ err }, "Falha ao processar comunidades/grupos de avisos");
        process.exit(1);
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] sessão encerrada: Apague ./auth e faça login novamente.");
        process.exit(1);
      }
      logger.warn({ code }, "[wa] conexão fechada antes de concluir a ferramenta");
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "Erro não tratado em tools/addWorkerToCommunityAnnouncements");
  process.exit(1);
});
