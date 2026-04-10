import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import fs from "node:fs/promises";
import path from "node:path";
import logger, { sanitizeLevel } from "../utils/logger.js";
import type { BoomError } from "../types/ErrorTypes.js";
import { getAuthStateDir } from "../baileys/auth-state-dir.js";
import { closePool, getRegistrationPhoneLookupRows, type RegistrationPhoneLookupRow } from "../db/pgsql.js";
import { processGroupsBaileys, collectMeBases, normalizeUserBase, type MinimalGroup } from "../utils/groups.js";
import { extractPhoneFromParticipant } from "../utils/jid.js";

configDotenv({ path: ".env" });

const NOT_FOUND_IN_DB = "Não encontrado no banco";
const PHONE_NOT_RESOLVED = "Telefone não resolvido na sessão";

type RegistrationLookupValue = {
  registration_id: number;
  name: string | null;
};

type GroupAdminReportEntry = {
  groupId: string;
  groupName: string;
  adminPhone: string;
  name: string;
  mb: number | string;
};

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore if folder exists
  }
}

function toDigitsPhone(input: string | undefined | null): string | null {
  if (!input) return null;
  const digits = input.replace(/\D+/g, "");
  return digits.length >= 7 ? digits : null;
}

function isLikelyBrazilianPhone(phone: string | null): phone is string {
  return Boolean(phone && /^55\d{10,11}$/.test(phone));
}

function buildBrazilianPhoneVariants(phone: string): string[] {
  const digits = toDigitsPhone(phone);
  if (!digits) return [];

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

function buildRegistrationLookup(rows: RegistrationPhoneLookupRow[]): Map<string, RegistrationLookupValue> {
  const phoneLookup = new Map<string, RegistrationLookupValue>();

  for (const row of rows) {
    const digits = toDigitsPhone(row.phone_number);
    if (!digits) continue;

    const value: RegistrationLookupValue = {
      registration_id: row.registration_id,
      name: row.name,
    };

    for (const variant of buildBrazilianPhoneVariants(digits)) {
      if (!phoneLookup.has(variant)) {
        phoneLookup.set(variant, value);
      }
    }
  }

  return phoneLookup;
}

function findRegistrationByPhone(
  phoneLookup: Map<string, RegistrationLookupValue>,
  phone: string | null,
): RegistrationLookupValue | null {
  if (!phone) return null;

  for (const variant of buildBrazilianPhoneVariants(phone)) {
    const match = phoneLookup.get(variant);
    if (match) return match;
  }

  return null;
}

function getFallbackPhoneFromMeBases(meBases: Set<string>): string | null {
  for (const base of meBases) {
    const digits = toDigitsPhone(base);
    if (isLikelyBrazilianPhone(digits)) {
      return digits;
    }
  }

  return null;
}

async function findMyAdminPhoneForGroup(
  group: MinimalGroup,
  meBases: Set<string>,
  resolveLidToPhone: (lid: string) => Promise<string | null>,
): Promise<string | null> {
  for (const participant of group.participants) {
    const participantId = typeof participant === "string" ? participant : (participant as { id?: string }).id;
    const participantJid = typeof participant === "string" ? undefined : (participant as { jid?: string }).jid;
    const participantPhone =
      typeof participant === "string" ? undefined : (participant as { phoneNumber?: string }).phoneNumber;
    const participantBase =
      normalizeUserBase(participantId) ?? normalizeUserBase(participantJid) ?? normalizeUserBase(participantPhone);

    if (!participantBase || !meBases.has(participantBase)) {
      continue;
    }

    const extractedPhone = await extractPhoneFromParticipant(participant, { resolveLidToPhone });
    if (extractedPhone) {
      return extractedPhone;
    }

    if (isLikelyBrazilianPhone(participantBase)) {
      return participantBase;
    }
  }

  return null;
}

async function safeClosePool(): Promise<void> {
  try {
    await closePool();
  } catch (err) {
    logger.warn({ err }, "Falha ao fechar pool do Postgres (não-fatal)");
  }
}

async function buildReport(sock: WASocket): Promise<{
  socketAdminPhone: string;
  socketAdminName: string;
  socketAdminMb: number | string;
  groups: GroupAdminReportEntry[];
}> {
  const { adminGroups, adminCommunity, adminCommunityAnnounce } = await processGroupsBaileys(sock);
  const groups = [...adminGroups, ...adminCommunity, ...adminCommunityAnnounce].sort((a, b) =>
    (a.subject ?? a.name ?? a.id).localeCompare(b.subject ?? b.name ?? b.id, "pt-BR"),
  );

  const meBases = collectMeBases(sock);
  const resolveLidToPhone = async (lid: string) => (await sock.signalRepository?.lidMapping?.getPNForLID(lid)) ?? null;
  const phoneLookup = buildRegistrationLookup(await getRegistrationPhoneLookupRows());

  let socketAdminPhone = getFallbackPhoneFromMeBases(meBases);
  for (const group of groups) {
    const groupAdminPhone = await findMyAdminPhoneForGroup(group, meBases, resolveLidToPhone);
    if (groupAdminPhone) {
      socketAdminPhone = groupAdminPhone;
      break;
    }
  }

  const socketRegistration = findRegistrationByPhone(phoneLookup, socketAdminPhone);

  const groupEntries: GroupAdminReportEntry[] = [];
  for (const group of groups) {
    const groupAdminPhone = (await findMyAdminPhoneForGroup(group, meBases, resolveLidToPhone)) ?? socketAdminPhone;
    const registration = findRegistrationByPhone(phoneLookup, groupAdminPhone) ?? socketRegistration;

    groupEntries.push({
      groupId: group.id,
      groupName: group.subject ?? group.name ?? group.id,
      adminPhone: groupAdminPhone ?? PHONE_NOT_RESOLVED,
      name: registration?.name?.trim() || NOT_FOUND_IN_DB,
      mb: registration?.registration_id ?? NOT_FOUND_IN_DB,
    });
  }

  return {
    socketAdminPhone: socketAdminPhone ?? PHONE_NOT_RESOLVED,
    socketAdminName: socketRegistration?.name?.trim() || NOT_FOUND_IN_DB,
    socketAdminMb: socketRegistration?.registration_id ?? NOT_FOUND_IN_DB,
    groups: groupEntries,
  };
}

async function main(): Promise<void> {
  const outDir = path.resolve("tools_results");
  await ensureDir(outDir);

  const { state, saveCreds } = await useMultiFileAuthState(getAuthStateDir());
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
        const report = await buildReport(sock);
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = path.join(outDir, `admin_groups_${ts}.json`);

        await fs.writeFile(
          outPath,
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              totals: {
                adminGroups: report.groups.length,
              },
              admin: {
                phone: report.socketAdminPhone,
                name: report.socketAdminName,
                mb: report.socketAdminMb,
              },
              groups: report.groups,
            },
            null,
            2,
          ),
          "utf8",
        );

        logger.info({ outPath, adminGroups: report.groups.length }, "Arquivo de grupos administrados salvo");
        await safeClosePool();
        setTimeout(() => process.exit(0), 50);
      } catch (err) {
        logger.error({ err }, "Falha ao gerar arquivo de grupos administrados");
        await safeClosePool();
        process.exit(1);
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] sessão encerrada: apague a pasta local auth e autentique novamente.");
        await safeClosePool();
        process.exit(1);
      }
      logger.warn({ code }, "[wa] conexão fechada antes de concluir a tool");
    }
  });
}

main().catch(async (err) => {
  logger.error({ err }, "Erro não tratado em tools/dumpAdminGroups");
  await safeClosePool();
  process.exit(1);
});
