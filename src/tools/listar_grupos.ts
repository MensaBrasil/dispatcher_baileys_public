import fs from "node:fs/promises";
import path from "node:path";
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type GroupMetadata,
  type GroupParticipant,
  makeWASocket,
  useMultiFileAuthState,
} from "baileys";
import { config as configDotenv } from "dotenv";
import qrcode from "qrcode-terminal";
import { getAuthStateDir } from "../baileys/auth-state-dir.js";
import type { BoomError } from "../types/ErrorTypes.js";
import { checkGroupType } from "../utils/checkGroupType.js";
import { collectMeBases, isAdminForMe } from "../utils/groups.js";
import logger, { sanitizeLevel } from "../utils/logger.js";

configDotenv({ path: ".env" });

type GroupListsReport = {
  data_geracao: string;
  totais: {
    total_grupos: number;
    grupos_MB: number;
    grupos_RJB: number;
    comunidades: number;
    grupos_aviso_comunidades: number;
    fora_regra_MB_RJB: number;
    grupos_socket_admin: number;
    grupos_socket_nao_admin: number;
  };
  grupos_MB: string[];
  grupos_RJB: string[];
  comunidades: string[];
  grupos_aviso_comunidades: string[];
  fora_regra_MB_RJB: string[];
  grupos_socket_admin: string[];
  grupos_socket_nao_admin: string[];
};

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore if folder exists
  }
}

function groupName(group: GroupMetadata): string {
  return group.subject ?? group.id;
}

function sortNames(names: string[]): string[] {
  return names.sort((a, b) => a.localeCompare(b, "pt-BR"));
}

async function buildReport(
  groups: GroupMetadata[],
  isAdmin: (group: GroupMetadata) => boolean,
): Promise<GroupListsReport> {
  const grupos_MB: string[] = [];
  const grupos_RJB: string[] = [];
  const comunidades: string[] = [];
  const grupos_aviso_comunidades: string[] = [];
  const fora_regra_MB_RJB: string[] = [];
  const grupos_socket_admin: string[] = [];
  const grupos_socket_nao_admin: string[] = [];

  for (const group of groups) {
    const name = groupName(group);

    if (isAdmin(group)) {
      grupos_socket_admin.push(name);
    } else {
      grupos_socket_nao_admin.push(name);
    }

    if (group.isCommunity) {
      comunidades.push(name);
      continue;
    }

    if (group.isCommunityAnnounce) {
      grupos_aviso_comunidades.push(name);
      continue;
    }

    const groupType = await checkGroupType(name);
    if (groupType === "MB") {
      grupos_MB.push(name);
      continue;
    }

    if (groupType === "RJB") {
      grupos_RJB.push(name);
      continue;
    }

    fora_regra_MB_RJB.push(name);
  }

  sortNames(grupos_MB);
  sortNames(grupos_RJB);
  sortNames(comunidades);
  sortNames(grupos_aviso_comunidades);
  sortNames(fora_regra_MB_RJB);
  sortNames(grupos_socket_admin);
  sortNames(grupos_socket_nao_admin);

  const totalCategoriasPrincipais =
    grupos_MB.length +
    grupos_RJB.length +
    comunidades.length +
    grupos_aviso_comunidades.length +
    fora_regra_MB_RJB.length;
  if (totalCategoriasPrincipais !== groups.length) {
    throw new Error(
      `Categorias principais somam ${totalCategoriasPrincipais}, mas foram lidos ${groups.length} grupos`,
    );
  }

  const totalCategoriasAdmin = grupos_socket_admin.length + grupos_socket_nao_admin.length;
  if (totalCategoriasAdmin !== groups.length) {
    throw new Error(`Categorias de admin somam ${totalCategoriasAdmin}, mas foram lidos ${groups.length} grupos`);
  }

  return {
    data_geracao: new Date().toISOString(),
    totais: {
      total_grupos: groups.length,
      grupos_MB: grupos_MB.length,
      grupos_RJB: grupos_RJB.length,
      comunidades: comunidades.length,
      grupos_aviso_comunidades: grupos_aviso_comunidades.length,
      fora_regra_MB_RJB: fora_regra_MB_RJB.length,
      grupos_socket_admin: grupos_socket_admin.length,
      grupos_socket_nao_admin: grupos_socket_nao_admin.length,
    },
    grupos_MB,
    grupos_RJB,
    comunidades,
    grupos_aviso_comunidades,
    fora_regra_MB_RJB,
    grupos_socket_admin,
    grupos_socket_nao_admin,
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
        const all = await sock.groupFetchAllParticipating();
        const groups = Object.values(all) as GroupMetadata[];
        const meBases = collectMeBases(sock);
        if (!meBases.size) {
          throw new Error("JID do usuário do socket não disponível");
        }
        const report = await buildReport(groups, (group) =>
          isAdminForMe((group.participants || []) as unknown as GroupParticipant[], meBases),
        );
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = path.join(outDir, `listar_grupos_${ts}.json`);

        await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

        console.log(JSON.stringify(report, null, 2));
        logger.info({ outPath, totalGroups: groups.length }, "Lista de grupos salva");
        setTimeout(() => process.exit(0), 50);
      } catch (err) {
        logger.error({ err }, "Falha ao listar grupos");
        process.exit(1);
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] sessão encerrada: apague a pasta local de autenticação e autentique novamente.");
        process.exit(1);
      }
      logger.warn({ code }, "[wa] conexão fechada antes de listar grupos");
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "Erro não tratado em tools/listar_grupos");
  process.exit(1);
});
