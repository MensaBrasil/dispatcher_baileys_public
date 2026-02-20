import { createHash } from "node:crypto";
import { config as configDotenv } from "dotenv";
import { Pool } from "pg";
import logger from "../utils/logger.js";
import type { DBGroupRequest, WhatsAppWorker } from "../types/DBTypes.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";
import type { WhatsappMessageRow } from "../types/DBTypes.js";

configDotenv({ path: ".env" });

// Shared connection pool
let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const host = process.env.PGHOST ?? process.env.POSTGRES_HOST ?? "127.0.0.1";
    const port = Number(process.env.PGPORT ?? process.env.POSTGRES_PORT ?? 5432);
    const user = process.env.PGUSER ?? process.env.POSTGRES_USER ?? "postgres";
    const password = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? undefined;
    const database = process.env.PGDATABASE ?? process.env.POSTGRES_DB ?? "postgres";

    pool = new Pool({ host, port, user, password, database, max: 10, idleTimeoutMillis: 30_000 });

    pool.on("error", (err) => {
      logger.error({ err }, "[pg] unexpected pool error");
    });
  }
  return pool;
}

type PgErrorLike = { code?: string; message?: string };
type ColumnLimitRow = { column_name: string; character_maximum_length: number | null };

let whatsappMessagesColumnLimits: Record<string, number | null> | null = null;

function parseVarcharLimit(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const message = "message" in err ? String((err as PgErrorLike).message ?? "") : "";
  const match = /character varying\((\d+)\)/i.exec(message);
  if (!match) return null;
  const limit = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(limit) ? limit : null;
}

async function getWhatsappMessagesColumnLimits(): Promise<Record<string, number | null>> {
  if (whatsappMessagesColumnLimits) return whatsappMessagesColumnLimits;
  const p = getPool();
  const query = `
    SELECT column_name, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'whatsapp_messages'
  `;
  try {
    const { rows } = await p.query<ColumnLimitRow>(query);
    const limits: Record<string, number | null> = {};
    for (const row of rows) {
      limits[row.column_name] = row.character_maximum_length ?? null;
    }
    whatsappMessagesColumnLimits = limits;
  } catch (err) {
    logger.warn({ err }, "[pg] Failed to read whatsapp_messages column limits; skipping length normalization");
    whatsappMessagesColumnLimits = {};
  }
  return whatsappMessagesColumnLimits;
}

function hashToLimit(value: string, limit: number): string {
  if (limit <= 0) return value;
  const hash = createHash("sha1").update(value).digest("hex");
  return hash.length >= limit ? hash.slice(0, limit) : hash.padEnd(limit, "0");
}

function normalizeGroupIdForLimit(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const [user] = value.split("@", 1);
  if (user && user.length <= limit) return user;
  return hashToLimit(value, limit);
}

function truncateToLimit(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

async function normalizeWhatsappMessagesGroupId(groupId: string): Promise<string> {
  const limits = await getWhatsappMessagesColumnLimits();
  const limit = limits.group_id;
  if (!limit || groupId.length <= limit) return groupId;
  return normalizeGroupIdForLimit(groupId, limit);
}

async function sanitizeWhatsappMessageRows(rows: WhatsappMessageRow[]): Promise<WhatsappMessageRow[]> {
  const limits = await getWhatsappMessagesColumnLimits();
  const messageIdLimit = limits.message_id ?? null;
  const groupIdLimit = limits.group_id ?? null;
  const phoneLimit = limits.phone ?? null;
  const messageTypeLimit = limits.message_type ?? null;
  const deviceTypeLimit = limits.device_type ?? null;
  const contentLimit = limits.content ?? null;

  if (!messageIdLimit && !groupIdLimit && !phoneLimit && !messageTypeLimit && !deviceTypeLimit && !contentLimit) {
    return rows;
  }

  const sanitized: WhatsappMessageRow[] = [];
  for (const row of rows) {
    const phone = row.phone;
    if (phone && phoneLimit && phone.length > phoneLimit) {
      logger.warn(
        { phoneLength: phone.length, phoneLimit },
        "[pg] Skipping whatsapp message with phone too long for schema",
      );
      continue;
    }

    let message_id = row.message_id;
    if (messageIdLimit && message_id.length > messageIdLimit) {
      message_id = hashToLimit(message_id, messageIdLimit);
    }

    let group_id = row.group_id;
    if (groupIdLimit && group_id.length > groupIdLimit) {
      group_id = normalizeGroupIdForLimit(group_id, groupIdLimit);
    }

    let message_type = row.message_type;
    if (messageTypeLimit && message_type.length > messageTypeLimit) {
      message_type = truncateToLimit(message_type, messageTypeLimit);
    }

    let device_type = row.device_type;
    if (deviceTypeLimit && device_type.length > deviceTypeLimit) {
      device_type = truncateToLimit(device_type, deviceTypeLimit);
    }

    let content = row.content;
    if (content && contentLimit && content.length > contentLimit) {
      content = truncateToLimit(content, contentLimit);
    }

    sanitized.push({
      ...row,
      message_id,
      group_id,
      phone,
      message_type,
      device_type,
      content,
    });
  }
  return sanitized;
}

function getMaxStringLengths(rows: WhatsappMessageRow[]) {
  const max = {
    message_id: 0,
    group_id: 0,
    phone: 0,
    message_type: 0,
    device_type: 0,
    content: 0,
  };
  for (const row of rows) {
    if (row.message_id.length > max.message_id) max.message_id = row.message_id.length;
    if (row.group_id.length > max.group_id) max.group_id = row.group_id.length;
    if (row.phone && row.phone.length > max.phone) max.phone = row.phone.length;
    if (row.message_type.length > max.message_type) max.message_type = row.message_type.length;
    if (row.device_type.length > max.device_type) max.device_type = row.device_type.length;
    if (row.content && row.content.length > max.content) max.content = row.content.length;
  }
  return max;
}

export async function getWhatsappQueue(group_id: string): Promise<DBGroupRequest[]> {
  const p = getPool();
  const query = `
    SELECT
      group_requests.id AS request_id,
      group_requests.registration_id,
      group_requests.group_id,
      group_requests.no_of_attempts,
      group_requests.last_attempt
    FROM
      group_requests
    WHERE
      no_of_attempts < 3
      AND group_id = $1
      AND fulfilled = FALSE
      AND (last_attempt < NOW() - INTERVAL '1 DAY' OR last_attempt IS NULL)
  `;
  const { rows } = await p.query<DBGroupRequest>(query, [group_id]);
  return rows;
}

export async function getPhoneNumbersWithStatus(): Promise<PhoneNumberStatusRow[]> {
  const p = getPool();
  const currentDate = new Date().toISOString().split("T")[0];
  const query = `
    WITH Gender AS (
      SELECT r.gender, r.registration_id FROM registration r
    ), MaxExpirationDates AS (
      SELECT registration_id, MAX(expiration_date) AS max_expiration_date
      FROM membership_payments
      GROUP BY registration_id
    ), LegalRepPhones AS (
      SELECT 
        registration_id,
        ARRAY_AGG(DISTINCT phone_num) AS all_legal_rep_phones
      FROM (
        SELECT registration_id, phone AS phone_num
        FROM legal_representatives
        WHERE phone IS NOT NULL
        UNION
        SELECT registration_id, alternative_phone AS phone_num
        FROM legal_representatives
        WHERE alternative_phone IS NOT NULL
      ) AS all_phones
      GROUP BY registration_id
    ), PhoneNumbers AS (
      SELECT
        p.phone_number AS phone_number,
        p.registration_id AS registration_id,
        g.gender AS gender,
        CASE
          WHEN med.max_expiration_date + INTERVAL '14 days' > $1::date THEN 'Active'
          WHEN r.transferred IS TRUE THEN 'Active'
          ELSE 'Inactive'
        END AS status,
        CASE WHEN DATE_PART('year', AGE(r.birth_date)) < 13 THEN TRUE ELSE FALSE END AS jb_under_13,
        CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 13 AND DATE_PART('year', AGE(r.birth_date)) < 18 THEN TRUE ELSE FALSE END AS jb_13_to_17,
        CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 18 THEN TRUE ELSE FALSE END AS is_adult,
        FALSE AS is_legal_representative,
        FALSE AS represents_minor,
        CASE 
          WHEN DATE_PART('year', AGE(r.birth_date)) >= 18 THEN TRUE  
          WHEN lrp.all_legal_rep_phones IS NULL THEN FALSE
          ELSE p.phone_number = ANY(lrp.all_legal_rep_phones)
        END AS child_phone_matches_legal_rep,
        CASE WHEN EXISTS (
          SELECT 1
          FROM whatsapp_auth_terms wat
          WHERE wat.registration_id = p.registration_id AND wat.accepted IS TRUE
        ) THEN TRUE ELSE FALSE END AS has_accepted_terms
      FROM phones p
      LEFT JOIN MaxExpirationDates med ON p.registration_id = med.registration_id
      LEFT JOIN registration r ON p.registration_id = r.registration_id
      LEFT JOIN Gender g ON p.registration_id = g.registration_id
      LEFT JOIN LegalRepPhones lrp ON p.registration_id = lrp.registration_id
      UNION ALL
      SELECT
        lr.phone AS phone_number,
        lr.registration_id,
        g.gender AS gender,
        CASE
          WHEN med.max_expiration_date + INTERVAL '14 days' > $1::date THEN 'Active'
          WHEN reg.transferred IS TRUE THEN 'Active'
          ELSE 'Inactive'
        END AS status,
        CASE WHEN DATE_PART('year', AGE(reg.birth_date)) < 13 THEN TRUE ELSE FALSE END AS jb_under_13,
        CASE WHEN DATE_PART('year', AGE(reg.birth_date)) >= 13 AND DATE_PART('year', AGE(reg.birth_date)) < 18 THEN TRUE ELSE FALSE END AS jb_13_to_17,
        CASE WHEN DATE_PART('year', AGE(reg.birth_date)) >= 18 THEN TRUE ELSE FALSE END AS is_adult,
        TRUE AS is_legal_representative,
        CASE                                            -- NEW: legal rep represents a minor iff represented child < 18
          WHEN DATE_PART('year', AGE(reg.birth_date)) < 18 THEN TRUE
          ELSE FALSE
        END AS represents_minor,
        TRUE AS child_phone_matches_legal_rep,
        CASE WHEN EXISTS (
          SELECT 1
          FROM whatsapp_auth_terms wat
          WHERE wat.registration_id = lr.registration_id AND wat.accepted IS TRUE
        ) THEN TRUE ELSE FALSE END AS has_accepted_terms
      FROM legal_representatives lr
      LEFT JOIN MaxExpirationDates med ON lr.registration_id = med.registration_id
      LEFT JOIN registration reg ON lr.registration_id = reg.registration_id
      LEFT JOIN Gender g ON lr.registration_id = g.registration_id
    )
    SELECT
      phone_number,
      registration_id,
      gender,
      MAX(status) AS status,
      BOOL_OR(jb_under_13) AS jb_under_13,
      BOOL_OR(jb_13_to_17) AS jb_13_to_17,
      BOOL_OR(is_adult) AS is_adult,
      BOOL_OR(is_legal_representative) AS is_legal_representative,
      BOOL_OR(represents_minor) AS represents_minor,
      BOOL_OR(child_phone_matches_legal_rep) AS child_phone_matches_legal_rep,
      BOOL_OR(has_accepted_terms) AS has_accepted_terms
    FROM PhoneNumbers
    WHERE phone_number IS NOT NULL
    GROUP BY phone_number, registration_id, gender
    ORDER BY status;
  `;
  const { rows } = await p.query<PhoneNumberStatusRow>(query, [currentDate]);
  return rows;
}

export type RegistrationFlags = {
  registration_id: number;
  jb_under_13: boolean;
  jb_13_to_17: boolean;
  is_adult: boolean;
  has_accepted_terms: boolean;
};

export async function getRegistrationFlags(registrationIds: number[]): Promise<Map<number, RegistrationFlags>> {
  const p = getPool();
  if (registrationIds.length === 0) return new Map();
  const query = `
    SELECT
      r.registration_id,
      CASE WHEN DATE_PART('year', AGE(r.birth_date)) < 13 THEN TRUE ELSE FALSE END AS jb_under_13,
      CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 13 AND DATE_PART('year', AGE(r.birth_date)) < 18 THEN TRUE ELSE FALSE END AS jb_13_to_17,
      CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 18 THEN TRUE ELSE FALSE END AS is_adult,
      CASE WHEN EXISTS (
        SELECT 1
        FROM whatsapp_auth_terms wat
        WHERE wat.registration_id = r.registration_id AND wat.accepted IS TRUE
      ) THEN TRUE ELSE FALSE END AS has_accepted_terms
    FROM registration r
    WHERE r.registration_id = ANY($1)
  `;
  const { rows } = await p.query<RegistrationFlags>(query, [registrationIds]);
  const flags = new Map<number, RegistrationFlags>();
  for (const row of rows) {
    flags.set(row.registration_id, row);
  }
  return flags;
}

export async function getLastCommunication(phoneNumber: string): Promise<{ reason: string; timestamp: Date } | false> {
  const p = getPool();
  const query = `
    SELECT reason, timestamp
    FROM whatsapp_comms
    WHERE phone_number = $1
      AND status = 'unresolved'
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  const { rows } = await p.query<{ reason: string; timestamp: Date }>(query, [phoneNumber]);
  return rows[0] ?? false;
}

export async function getLastCommunicationAnyStatus(
  phoneNumber: string,
): Promise<{ reason: string; timestamp: Date; status: string } | false> {
  const p = getPool();
  const query = `
    SELECT reason, timestamp, status
    FROM whatsapp_comms
    WHERE phone_number = $1
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  const { rows } = await p.query<{ reason: string; timestamp: Date; status: string }>(query, [phoneNumber]);
  return rows[0] ?? false;
}

export async function logCommunication(phoneNumber: string, reason: string): Promise<void> {
  const p = getPool();
  const query = `
    INSERT INTO whatsapp_comms (phone_number, reason, timestamp, status)
    VALUES ($1, $2, NOW(), 'unresolved')
    ON CONFLICT (phone_number, reason)
    DO UPDATE SET timestamp = NOW(), status = 'unresolved'
  `;
  await p.query(query, [phoneNumber, reason]);
}

export async function resolveCommunications(phoneNumber: string): Promise<void> {
  const p = getPool();
  const query = `
    UPDATE whatsapp_comms
    SET status = 'resolved'
    WHERE phone_number = $1
      AND status = 'unresolved'
  `;
  await p.query(query, [phoneNumber]);
}

export async function getPreviousGroupMembers(groupId: string): Promise<string[]> {
  const p = getPool();
  const query = `SELECT phone_number FROM member_groups WHERE group_id = $1 AND exit_date IS NULL`;
  const { rows } = await p.query<{ phone_number: string }>(query, [groupId]);
  return rows.map((r) => r.phone_number);
}

export async function recordUserExitFromGroup(phone_number: string, group_id: string, reason: string): Promise<void> {
  const p = getPool();
  const query = `
    UPDATE member_groups
    SET exit_date = NOW(), removal_reason = $3
    WHERE phone_number = $1 AND group_id = $2 AND exit_date IS NULL
  `;
  await p.query(query, [phone_number, group_id, reason]);
}

export async function recordUserEntryToGroup(
  registration_id: number,
  phone_number: string,
  group_id: string,
  status: "Active" | "Inactive",
): Promise<void> {
  const p = getPool();
  const query = `
    INSERT INTO member_groups (registration_id, phone_number, group_id, status)
    VALUES ($1, $2, $3, $4)
  `;
  await p.query(query, [registration_id, phone_number, group_id, status]);
}

export async function getMemberPhoneNumbers(registration_id: number): Promise<string[]> {
  const p = getPool();
  const query = `
    SELECT phone_number AS phone FROM phones WHERE registration_id = $1
    UNION ALL
    SELECT phone FROM legal_representatives WHERE registration_id = $1
    UNION ALL
    SELECT alternative_phone AS phone FROM legal_representatives WHERE registration_id = $1 AND alternative_phone IS NOT NULL
  `;
  const { rows } = await p.query<{ phone: string }>(query, [registration_id]);
  return rows.map((r) => r.phone);
}

export async function registerWhatsappAddFulfilled(id: number): Promise<void> {
  const p = getPool();
  const query = `UPDATE group_requests SET fulfilled = true, last_attempt = NOW(), updated_at = NOW() WHERE id = $1`;
  await p.query(query, [id]);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function saveGroupsToList(groups: Array<{ group_id: string; group_name: string }>): Promise<void> {
  const p = getPool();
  await p.query("BEGIN");
  try {
    await p.query("DELETE FROM group_list");
    if (groups.length > 0) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      for (let i = 0; i < groups.length; i++) {
        const base = i * 2;
        placeholders.push(`($${base + 1}, $${base + 2})`);
        values.push(groups[i]!.group_name, groups[i]!.group_id);
      }
      const insertSql = `INSERT INTO group_list (group_name, group_id) VALUES ${placeholders.join(",")}`;
      await p.query(insertSql, values);
    }
    await p.query("COMMIT");
  } catch (err) {
    await p.query("ROLLBACK");
    throw err;
  }
}

/**
 * Returns the latest message timestamp (unix seconds) for a given group
 * or 0 if nothing exists.
 */
export async function getLastMessageTimestamp(groupId: string): Promise<number> {
  const p = getPool();
  const normalizedGroupId = await normalizeWhatsappMessagesGroupId(groupId);
  const query = `
    SELECT EXTRACT(EPOCH FROM MAX(timestamp))::INT AS unix_timestamp
    FROM whatsapp_messages
    WHERE group_id = $1
  `;
  const { rows } = await p.query<{ unix_timestamp: number | null }>(query, [normalizedGroupId]);
  const ts = rows[0]?.unix_timestamp ?? 0;
  return ts || 0;
}

/**
 * Inserts WhatsApp messages in bulk. Ignores duplicates on message_id.
 */
export async function insertNewWhatsAppMessages(messages: WhatsappMessageRow[]): Promise<number> {
  if (!messages.length) return 0;
  // Defensive: skip any rows without phone to satisfy NOT NULL constraint
  const valid = messages.filter((m) => !!m.phone);
  if (!valid.length) {
    logger.debug({ dropped: messages.length }, "[pg] No valid whatsapp messages to insert (missing phone)");
    return 0;
  }
  const sanitized = await sanitizeWhatsappMessageRows(valid);
  if (!sanitized.length) {
    logger.debug({ dropped: valid.length }, "[pg] No valid whatsapp messages to insert (schema limits)");
    return 0;
  }
  const p = getPool();

  const cols = [
    "message_id",
    "group_id",
    "registration_id",
    "timestamp",
    "phone",
    "message_type",
    "device_type",
    "content",
  ];

  const values: unknown[] = [];
  const placeholders: string[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    const base = i * cols.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
    const m = sanitized[i]!;
    values.push(
      m.message_id,
      m.group_id,
      m.registration_id ?? null,
      m.timestamp,
      m.phone!,
      m.message_type,
      m.device_type,
      m.content ?? null,
    );
  }

  const sql = `
    INSERT INTO whatsapp_messages (${cols.join(", ")})
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (message_id) DO NOTHING
  `;
  try {
    const res = await p.query(sql, values);
    // rowCount will be 0 when all conflicted; PG may not return per-row inserted count for multi-values
    // Fallback to messages.length is inaccurate when conflicts happen; try to infer using GET DIAGNOSTICS is complex here.
    // Return res.rowCount if available, else 0.
    return res.rowCount ?? 0;
  } catch (err) {
    const pgErr = err as PgErrorLike;
    const limit = parseVarcharLimit(err);
    if (pgErr.code === "22001" || limit !== null) {
      const maxLens = getMaxStringLengths(valid);
      const effectiveLimit = limit ?? 0;
      const fieldsOverLimit =
        effectiveLimit > 0
          ? Object.entries(maxLens)
              .filter(([, len]) => len > effectiveLimit)
              .map(([field]) => field)
          : [];
      logger.error(
        { err, limit: limit ?? undefined, maxLens, fieldsOverLimit },
        "[pg] whatsapp_messages value too long; check column widths",
      );
    }
    throw err;
  }
}

export default { getWhatsappQueue, closePool };

/**
 * Retrieves all WhatsApp workers (return only stable columns).
 */
export async function getAllWhatsAppWorkers(): Promise<WhatsAppWorker[]> {
  const query = "SELECT id, worker_phone FROM whatsapp_workers;";
  const { rows } = await getPool().query<WhatsAppWorker>(query);
  return rows;
}

/**
 * Best-effort mapping between LID and phone number for future lookups.
 * Requires table:
 * CREATE TABLE IF NOT EXISTS whatsapp_lid_mappings (
 *   lid TEXT PRIMARY KEY,
 *   phone_number TEXT NOT NULL,
 *   source TEXT,
 *   last_seen TIMESTAMPTZ DEFAULT NOW()
 * );
 */
export async function upsertLidMapping(lid: string, phone: string, source = "unknown"): Promise<void> {
  const p = getPool();
  const query = `
    INSERT INTO whatsapp_lid_mappings (lid, phone_number, source, last_seen)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (lid)
    DO UPDATE SET phone_number = EXCLUDED.phone_number, source = EXCLUDED.source, last_seen = NOW()
  `;
  await p.query(query, [lid, phone, source]);
}
