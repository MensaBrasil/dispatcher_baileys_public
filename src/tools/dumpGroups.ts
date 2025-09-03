import { config as configDotenv } from "dotenv";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  GroupMetadata,
  GroupParticipant,
} from "baileys";
import qrcode from "qrcode-terminal";
import fs from "node:fs/promises";
import path from "node:path";
import logger, { sanitizeLevel } from "../utils/logger.js";
import type { BoomError } from "../types/ErrorTypes.js";

configDotenv({ path: ".env" });

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore if folder exists
  }
}

async function main(): Promise<void> {
  const outDir = path.resolve("tools_results");
  await ensureDir(outDir);

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
    if (qr) {
      if (qr !== lastQR) {
        lastQR = qr;
        qrcode.generate(qr, { small: true });
        logger.info("Scan the QR code in WhatsApp > Connected devices");
      }
    }

    if (connection === "open") {
      try {
        const all = await sock.groupFetchAllParticipating();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = path.join(outDir, `groups_dump_${ts}.json`);
        await fs.writeFile(outPath, JSON.stringify(all, null, 2), "utf8");
        // Build a concise summary
        const values = Object.values(all) as GroupMetadata[];
        const total = values.length;
        const meJid = sock.user?.id;
        type MaybeJid = { jid?: string };
        const isMe = (p: GroupParticipant & MaybeJid, me: string | undefined) => {
          if (!me) return false;
          const pid = p.id;
          const pjid = p.jid;
          return pid === me || pjid === me;
        };
        const isAdmin = (g: GroupMetadata) =>
          (g.participants || []).some(
            (p) => isMe(p as GroupParticipant & MaybeJid, meJid) && Boolean((p as GroupParticipant).admin),
          );
        const community = values.filter((g) => Boolean(g.isCommunity)).length;
        const communityAnnounce = values.filter((g) => Boolean(g.isCommunityAnnounce)).length;
        const nonCommunity = total - community - communityAnnounce;
        const nonCommunityAnnounce = values.filter(
          (g) => !g.isCommunity && !g.isCommunityAnnounce && Boolean(g.announce),
        ).length;
        const addressingCounts = values.reduce<Record<string, number>>((acc, g) => {
          const key = g.addressingMode ?? "unknown";
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
        // Community subgroup summary
        const byId: Record<string, GroupMetadata> = Object.fromEntries(values.map((g) => [g.id, g]));
        const subgroupsByCommunity: Record<string, number> = {};
        for (const g of values) {
          const parent = g.linkedParent;
          if (parent && byId[parent] && byId[parent].isCommunity) {
            subgroupsByCommunity[parent] = (subgroupsByCommunity[parent] ?? 0) + 1;
          }
        }
        const communitiesWithNames = Object.entries(byId)
          .filter(([, g]) => Boolean(g.isCommunity))
          .map(([id, g]) => ({ id, subject: g.subject, subgroups: subgroupsByCommunity[id] ?? 0 }));
        const withoutCommunity = values.filter(
          (g) => !g.isCommunity && !g.isCommunityAnnounce && !g.linkedParent,
        ).length;
        const adminCount = values.filter((g) => isAdmin(g)).length;
        const largest = values
          .map((g) => ({ id: g.id, subject: g.subject, size: g.size ?? 0 }))
          .sort((a, b) => b.size - a.size)
          .slice(0, 10);

        const summary = {
          totals: {
            totalGroups: total,
            communityGroups: community,
            communityAnnounceGroups: communityAnnounce,
            nonCommunityGroups: nonCommunity,
            nonCommunityAnnounceGroups: nonCommunityAnnounce,
            groupsWithoutCommunity: withoutCommunity,
            adminGroups: adminCount,
          },
          addressingMode: addressingCounts,
          communities: communitiesWithNames,
          largestGroupsTop10: largest,
        };
        const summaryPath = path.join(outDir, `groups_summary_${ts}.json`);
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
        logger.info({ outPath, summaryPath }, "Groups metadata and summary saved");
        setTimeout(() => process.exit(0), 50);
      } catch (err) {
        logger.error({ err }, "Failed to fetch or save groups");
        process.exit(1);
      }
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as BoomError)?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        logger.fatal({ code }, "[wa] connection closed: Session logged out. Delete ./auth and link again.");
        process.exit(1);
      }
      logger.warn({ code }, "[wa] connection closed before dumping groups");
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "Unhandled error in tools/dumpGroups");
  process.exit(1);
});
