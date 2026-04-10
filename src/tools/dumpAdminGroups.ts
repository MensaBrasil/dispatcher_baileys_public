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

type AdminEntry = {
  telefone: string;
  nome: string;
  mb: number | string;
  papel: "admin" | "superadmin";
};

type GroupAdminReportEntry = {
  id_grupo: string;
  nome_grupo: string;
  administradores: AdminEntry[];
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

function getParticipantAdminRole(participant: MinimalGroup["participants"][number]): "admin" | "superadmin" | null {
  if (participant && typeof participant === "object" && "admin" in participant) {
    const role = (participant as { admin?: unknown }).admin;
    if (role === "admin" || role === "superadmin") {
      return role;
    }
  }

  return null;
}

function getParticipantBase(participant: MinimalGroup["participants"][number]): string | null {
  const participantId = typeof participant === "string" ? participant : (participant as { id?: string }).id;
  const participantJid = typeof participant === "string" ? undefined : (participant as { jid?: string }).jid;
  const participantPhone =
    typeof participant === "string" ? undefined : (participant as { phoneNumber?: string }).phoneNumber;

  return normalizeUserBase(participantId) ?? normalizeUserBase(participantJid) ?? normalizeUserBase(participantPhone);
}

async function buildAdminEntriesForGroup(
  group: MinimalGroup,
  meBases: Set<string>,
  resolveLidToPhone: (lid: string) => Promise<string | null>,
  phoneLookup: Map<string, RegistrationLookupValue>,
): Promise<AdminEntry[]> {
  const admins: AdminEntry[] = [];
  const seen = new Set<string>();

  for (const participant of group.participants) {
    const role = getParticipantAdminRole(participant);
    if (!role) continue;

    const participantBase = getParticipantBase(participant);
    const extractedPhone = await extractPhoneFromParticipant(participant, { resolveLidToPhone });
    const resolvedPhone = extractedPhone ?? (isLikelyBrazilianPhone(participantBase) ? participantBase : null);
    const registration = findRegistrationByPhone(phoneLookup, resolvedPhone);
    const dedupeKey = resolvedPhone ?? participantBase ?? JSON.stringify(participant);

    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    admins.push({
      telefone: resolvedPhone ?? PHONE_NOT_RESOLVED,
      nome: registration?.name?.trim() || NOT_FOUND_IN_DB,
      mb: registration?.registration_id ?? NOT_FOUND_IN_DB,
      papel: role,
    });
  }

  return admins;
}

async function safeClosePool(): Promise<void> {
  try {
    await closePool();
  } catch (err) {
    logger.warn({ err }, "Falha ao fechar pool do Postgres (não-fatal)");
  }
}

async function buildReport(sock: WASocket): Promise<{
  totalAdmins: number;
  groups: GroupAdminReportEntry[];
}> {
  const { adminGroups, adminCommunity, adminCommunityAnnounce } = await processGroupsBaileys(sock);
  const groups = [...adminGroups, ...adminCommunity, ...adminCommunityAnnounce].sort((a, b) =>
    (a.subject ?? a.name ?? a.id).localeCompare(b.subject ?? b.name ?? b.id, "pt-BR"),
  );

  const meBases = collectMeBases(sock);
  const resolveLidToPhone = async (lid: string) => (await sock.signalRepository?.lidMapping?.getPNForLID(lid)) ?? null;
  const phoneLookup = buildRegistrationLookup(await getRegistrationPhoneLookupRows());

  const groupEntries: GroupAdminReportEntry[] = [];
  let totalAdmins = 0;
  for (const group of groups) {
    const ownAdminPhone = await findMyAdminPhoneForGroup(group, meBases, resolveLidToPhone);
    const admins = await buildAdminEntriesForGroup(group, meBases, resolveLidToPhone, phoneLookup);

    if (ownAdminPhone) {
      const hasCurrentSocket = admins.some((admin) => admin.telefone === ownAdminPhone);
      if (!hasCurrentSocket) {
        const registration = findRegistrationByPhone(phoneLookup, ownAdminPhone);
        admins.push({
          telefone: ownAdminPhone,
          nome: registration?.name?.trim() || NOT_FOUND_IN_DB,
          mb: registration?.registration_id ?? NOT_FOUND_IN_DB,
          papel: "admin",
        });
      }
    }

    groupEntries.push({
      id_grupo: group.id,
      nome_grupo: group.subject ?? group.name ?? group.id,
      administradores: admins,
    });
    totalAdmins += admins.length;
  }

  return {
    totalAdmins,
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
              data_geracao: new Date().toISOString(),
              totais: {
                grupos_com_admin: report.groups.length,
                administradores: report.totalAdmins,
              },
              grupos: report.groups,
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
