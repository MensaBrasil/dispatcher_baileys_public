import { config as configDotenv } from "dotenv";
import type { WAMessage, WASocket } from "baileys";
import { getContentType, getDevice, proto } from "baileys";
import logger from "../utils/logger.js";
import { checkPhoneNumber, preprocessPhoneNumbers } from "../utils/phoneCheck.js";
import { getLastMessageTimestamp, insertNewWhatsAppMessages, upsertLidMapping } from "../db/pgsql.js";
import type { WhatsappMessageRow } from "../types/DBTypes.js";
import { checkGroupType, isOrgMBGroup } from "../utils/checkGroupType.js";
import { resolveParticipantIdentity, type ResolveLidToPhoneFn } from "../utils/jid.js";

configDotenv({ path: ".env" });

type AllowedGroup = { id: string; name: string };

const storeGroupMessageContent = process.env.WPP_STORE_GROUP_MESSAGE_CONTENT === "true";

function extractTextContent(msg: WAMessage): string | null {
  const ctype = getContentType(msg.message ?? undefined);
  if (!ctype) return null;
  const m = msg.message as proto.IMessage | undefined;
  switch (ctype) {
    case "conversation":
      return m?.conversation ?? null;
    case "extendedTextMessage":
      return m?.extendedTextMessage?.text ?? null;
    case "ephemeralMessage":
      return (
        m?.ephemeralMessage?.message?.extendedTextMessage?.text ?? m?.ephemeralMessage?.message?.conversation ?? null
      );
    case "viewOnceMessageV2":
    case "viewOnceMessage":
      return (
        m?.viewOnceMessageV2?.message?.extendedTextMessage?.text ??
        m?.viewOnceMessageV2?.message?.conversation ??
        m?.viewOnceMessage?.message?.extendedTextMessage?.text ??
        m?.viewOnceMessage?.message?.conversation ??
        null
      );
    default:
      return null;
  }
}

export type MessageSyncOptions = {
  /** If true, use last timestamp in DB to filter history messages (best-effort) */
  filterByLastTimestamp?: boolean;
  /** Max batch size per DB insert */
  dbBatchSize?: number;
};

/**
 * Build allowed groups set by name classification: non-community handled by caller; here we ensure Mensa types, excluding OrgMB
 */
export async function buildAllowedGroups(
  groups: Array<{ id: string; subject?: string; name?: string }>,
): Promise<AllowedGroup[]> {
  const allowed: AllowedGroup[] = [];
  for (const g of groups) {
    const name = g.subject ?? g.name ?? g.id;
    if (!name) continue;
    if (isOrgMBGroup(name)) continue; // explicit exclusion
    const t = await checkGroupType(name);
    if (t && t !== "OrgMB") {
      allowed.push({ id: g.id, name });
    }
  }
  return allowed;
}

/**
 * Create a message processor bound to a given socket and set of allowed groups.
 * It can be reused across events (messaging-history.set & messages.upsert).
 */
export function createMessageProcessor(
  sock: WASocket,
  allowedGroups: AllowedGroup[],
  options: MessageSyncOptions = {},
) {
  const allowedSet = new Set(allowedGroups.map((g) => g.id));
  const dbBatchSize = Math.max(1, options.dbBatchSize ?? 100);

  let phoneMap: ReturnType<typeof preprocessPhoneNumbers> | undefined;
  const lidMappingStore = sock.signalRepository?.lidMapping;
  const resolveLidToPhone: ResolveLidToPhoneFn | undefined = lidMappingStore
    ? async (lid) => (await lidMappingStore.getPNForLID(lid)) ?? null
    : undefined;

  async function persistLidMappings(mappings: Map<string, { phone: string; source: string }>) {
    if (!mappings.size) return;
    for (const [lid, { phone, source }] of mappings.entries()) {
      try {
        if (lidMappingStore) {
          await lidMappingStore.storeLIDPNMappings([{ lid, pn: phone }]);
        }
      } catch (err) {
        logger.debug({ err, lid }, "Failed to store LID mapping in memory store");
      }
      try {
        await upsertLidMapping(lid, phone, source);
      } catch (err) {
        logger.warn({ err, lid }, "Failed to persist LID mapping to DB (ensure schema is updated)");
      }
    }
  }

  async function ensurePhoneMap() {
    if (!phoneMap) {
      // Lazy import to avoid circular deps
      const { getPhoneNumbersWithStatus } = await import("../db/pgsql.js");
      const rows = await getPhoneNumbersWithStatus();
      phoneMap = preprocessPhoneNumbers(rows);
    }
    return phoneMap;
  }

  async function processMessages(messages: WAMessage[]): Promise<number> {
    if (!messages.length) return 0;
    const pmap = await ensurePhoneMap();

    // Group messages by groupId for optional timestamp filtering
    const byGroup = new Map<string, WAMessage[]>();
    for (const m of messages) {
      const gid = m.key.remoteJid;
      if (!gid || !allowedSet.has(gid)) continue;
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid)!.push(m);
    }

    let totalInserted = 0;
    for (const [groupId, list] of byGroup.entries()) {
      let minTs = 0;
      if (options.filterByLastTimestamp) {
        try {
          minTs = await getLastMessageTimestamp(groupId);
        } catch (err) {
          logger.warn({ err, groupId }, "Failed to get last message timestamp; will insert with conflicts ignored");
        }
      }

      // Build rows
      const rows: WhatsappMessageRow[] = [];
      const lidMappings = new Map<string, { phone: string; source: string }>();
      for (const m of list) {
        const unix = Number(m.messageTimestamp ?? 0);
        if (options.filterByLastTimestamp && unix <= minTs) {
          continue;
        }
        const message_id = m.key.id ?? `${groupId}-${unix}-${Math.random()}`;
        const identity = await resolveParticipantIdentity(m.key.participant ?? m.key.remoteJid ?? "", {
          altJid:
            (m.key as { participantAlt?: string; remoteJidAlt?: string }).participantAlt ??
            (m.key as { remoteJidAlt?: string }).remoteJidAlt,
          resolveLidToPhone,
        });
        const phoneRaw = identity.phone;
        const phone = phoneRaw ? (phoneRaw.startsWith("55") ? phoneRaw : `55${phoneRaw}`) : null;

        // We don't insert messages without a resolvable phone number
        if (!phone) {
          logger.debug({ groupId, message_id }, "Skipping message without phone");
          continue;
        }
        if (identity.lid) {
          lidMappings.set(identity.lid, { phone, source: "message" });
        }
        let registration_id: number | null = null;
        if (phone && pmap) {
          const resp = checkPhoneNumber(pmap, phone);
          registration_id = resp.found ? (resp.mb ?? null) : null;
        }
        const message_type = getContentType(m.message ?? undefined) || "unknown";
        const device_type = getDevice(m.key.id ?? "") || "unknown";
        const content = storeGroupMessageContent ? extractTextContent(m) : null;

        const row: WhatsappMessageRow = {
          message_id,
          group_id: groupId,
          registration_id,
          timestamp: new Date(unix * 1000),
          phone,
          message_type,
          device_type,
          content,
        };
        rows.push(row);
      }

      // Insert in batches
      for (let i = 0; i < rows.length; i += dbBatchSize) {
        const slice = rows.slice(i, i + dbBatchSize);
        if (!slice.length) continue;
        try {
          const inserted = await insertNewWhatsAppMessages(slice);
          totalInserted += inserted;
        } catch (err) {
          logger.error({ err, groupId, count: slice.length }, "Failed to insert whatsapp messages batch");
        }
      }
      // Persist LID<->PN mappings best-effort
      try {
        await persistLidMappings(lidMappings);
      } catch (err) {
        logger.debug({ err, groupId }, "Failed to persist LID mappings (non-fatal)");
      }
    }
    return totalInserted;
  }

  return { processMessages };
}
