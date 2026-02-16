import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import { Command } from "commander";
import logger, { sanitizeLevel } from "../utils/logger.js";
import type { BoomError } from "../types/ErrorTypes.js";
import { processGroupsBaileys } from "../utils/groups.js";
import { extractPhoneFromParticipant } from "../utils/jid.js";
import { sendToQueue, clearQueue, disconnect as disconnectRedis } from "../db/redis.js";
import { buildProtectedPhoneMatcher } from "../utils/phoneList.js";

configDotenv({ path: ".env" });
const isDontRemoveNumber = buildProtectedPhoneMatcher(process.env.DONT_REMOVE_NUMBERS);

type RemovalQueueItem = {
  type: "remove";
  registration_id: number | null;
  groupId: string;
  phone: string;
  reason: string;
  communityId?: string | null;
};

function toDigitsPhone(input: string): string {
  return input.replace(/\D+/g, "");
}

function expandBrazilianPhoneVariants(phone: string): string[] {
  const digits = toDigitsPhone(phone);
  const variants = new Set<string>([digits]);

  if (!digits.startsWith("55")) {
    return [...variants];
  }

  const dddPrefix = digits.slice(0, 4);
  const localNumber = digits.slice(4);

  if (localNumber.length === 8) {
    variants.add(`${dddPrefix}9${localNumber}`);
  } else if (localNumber.length === 9 && localNumber.startsWith("9")) {
    variants.add(`${dddPrefix}${localNumber.slice(1)}`);
  }

  return [...variants];
}

async function findGroupsForPhone(
  sock: WASocket,
  targetPhones: Set<string>,
  fallbackPhone: string,
): Promise<RemovalQueueItem[]> {
  const { groups, community, communityAnnounce } = await processGroupsBaileys(sock);
  const allGroups = [...groups, ...community, ...communityAnnounce];

  const resolveLidToPhone = async (lid: string) => {
    return (await sock.signalRepository?.lidMapping?.getPNForLID(lid)) ?? null;
  };

  const queueItems: RemovalQueueItem[] = [];
  const alreadyAddedGroupIds = new Set<string>();

  for (const group of allGroups) {
    if (alreadyAddedGroupIds.has(group.id)) {
      continue;
    }

    let foundInGroup = false;
    let matchedPhone: string | null = null;
    for (const participant of group.participants) {
      const participantPhone = await extractPhoneFromParticipant(participant, { resolveLidToPhone });
      if (participantPhone && targetPhones.has(participantPhone)) {
        foundInGroup = true;
        matchedPhone = participantPhone;
        break;
      }
    }

    if (!foundInGroup) {
      continue;
    }

    alreadyAddedGroupIds.add(group.id);
    queueItems.push({
      type: "remove",
      registration_id: null,
      groupId: group.id,
      phone: matchedPhone ?? fallbackPhone,
      reason: "Manual removal tool request.",
      communityId: group.announceGroup ?? null,
    });
  }

  return queueItems;
}

async function safeDisconnectRedis(): Promise<void> {
  try {
    await disconnectRedis();
  } catch (err) {
    logger.warn({ err }, "Falha ao desconectar do Redis (não-fatal)");
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .description("Enfileira remoção de um contato em todos os grupos dos quais ele participa")
    .requiredOption("--phone <phone>", "Telefone do contato (apenas dígitos ou com +)");
  program.parse(process.argv);
  const opts = program.opts<{ phone: string }>();

  const targetPhone = toDigitsPhone(opts.phone);
  if (!targetPhone || targetPhone.length < 7) {
    logger.fatal({ phone: opts.phone }, "Telefone inválido");
    process.exit(1);
  }
  if (isDontRemoveNumber(targetPhone)) {
    logger.fatal({ phone: targetPhone }, "Telefone protegido por DONT_REMOVE_NUMBERS e não pode ser removido");
    process.exit(1);
  }
  const targetPhones = new Set(expandBrazilianPhoneVariants(targetPhone));

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
    if (qr && qr !== lastQR) {
      lastQR = qr;
      qrcode.generate(qr, { small: true });
      logger.info("Escaneie o QR code no WhatsApp > Dispositivos conectados");
    }

    if (connection === "open") {
      try {
        const queueItems = await findGroupsForPhone(sock, targetPhones, targetPhone);

        if (queueItems.length === 0) {
          logger.warn(
            { phone: targetPhone, variants: [...targetPhones] },
            "Contato não encontrado em nenhum grupo visível pela sessão",
          );
          await safeDisconnectRedis();
          setTimeout(() => process.exit(0), 50);
          return;
        }

        const queueCleared = await clearQueue("removeQueue");
        if (!queueCleared) {
          logger.error(
            { phone: targetPhone, queue: "removeQueue" },
            "Falha ao limpar fila de remoção antes do enfileiramento",
          );
          await safeDisconnectRedis();
          process.exit(1);
          return;
        }

        const queued = await sendToQueue(queueItems, "removeQueue");
        if (!queued) {
          logger.error({ phone: targetPhone }, "Falha ao enfileirar remoções");
          await safeDisconnectRedis();
          process.exit(1);
          return;
        }

        logger.info(
          {
            phone: targetPhone,
            groupsMatched: queueItems.length,
            queue: "removeQueue",
          },
          "Remoções enfileiradas com sucesso",
        );

        for (const item of queueItems) {
          logger.info(
            { groupId: item.groupId, communityId: item.communityId ?? null, phone: item.phone },
            "Remoção enfileirada",
          );
        }

        await safeDisconnectRedis();
        setTimeout(() => process.exit(0), 50);
      } catch (err) {
        logger.error({ err, phone: targetPhone }, "Erro ao buscar grupos do contato e enfileirar remoções");
        await safeDisconnectRedis();
        process.exit(1);
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] sessão encerrada: apague ./auth e autentique novamente");
        process.exit(1);
      }
      logger.warn({ code }, "[wa] conexão fechada antes da conclusão da tool");
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "Erro não tratado em tools/queueContactRemoval");
  process.exit(1);
});
