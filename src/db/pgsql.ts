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
          WHEN med.max_expiration_date > $1 THEN 'Active'
          WHEN r.transferred IS TRUE THEN 'Active'
          ELSE 'Inactive'
        END AS status,
        CASE WHEN DATE_PART('year', AGE(r.birth_date)) <= 11 THEN TRUE ELSE FALSE END AS jb_under_10,
        CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 10 AND DATE_PART('year', AGE(r.birth_date)) < 18 THEN TRUE ELSE FALSE END AS jb_over_10,
        CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 12 AND DATE_PART('year', AGE(r.birth_date)) < 18 THEN TRUE ELSE FALSE END AS jb_over_12,
        CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 18 THEN TRUE ELSE FALSE END AS is_adult,
        FALSE AS is_legal_representative,
        FALSE AS represents_minor,
        CASE 
          WHEN DATE_PART('year', AGE(r.birth_date)) >= 18 THEN TRUE  
          WHEN lrp.all_legal_rep_phones IS NULL THEN FALSE
          ELSE p.phone_number = ANY(lrp.all_legal_rep_phones)
        END AS child_phone_matches_legal_rep
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
          WHEN med.max_expiration_date > $1 THEN 'Active'
          WHEN reg.transferred IS TRUE THEN 'Active'
          ELSE 'Inactive'
        END AS status,
        CASE WHEN DATE_PART('year', AGE(reg.birth_date)) <= 11 THEN TRUE ELSE FALSE END AS jb_under_10,
        CASE WHEN DATE_PART('year', AGE(reg.birth_date)) >= 10 AND DATE_PART('year', AGE(reg.birth_date)) < 18 THEN TRUE ELSE FALSE END AS jb_over_10,
        CASE WHEN DATE_PART('year', AGE(reg.birth_date)) >= 12 AND DATE_PART('year', AGE(reg.birth_date)) < 18 THEN TRUE ELSE FALSE END AS jb_over_12,
        CASE WHEN DATE_PART('year', AGE(reg.birth_date)) >= 18 THEN TRUE ELSE FALSE END AS is_adult,
        TRUE AS is_legal_representative,
        CASE                                            -- NEW: legal rep represents a minor iff represented child < 18
          WHEN DATE_PART('year', AGE(reg.birth_date)) < 18 THEN TRUE
          ELSE FALSE
        END AS represents_minor,
        TRUE AS child_phone_matches_legal_rep 
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
      BOOL_OR(jb_under_10) AS jb_under_10,
      BOOL_OR(jb_over_10) AS jb_over_10,
      BOOL_OR(jb_over_12) AS jb_over_12,
      BOOL_OR(is_adult) AS is_adult,
      BOOL_OR(is_legal_representative) AS is_legal_representative,
      BOOL_OR(represents_minor) AS represents_minor,
      BOOL_OR(child_phone_matches_legal_rep) AS child_phone_matches_legal_rep
    FROM PhoneNumbers
    WHERE phone_number IS NOT NULL
    GROUP BY phone_number, registration_id, gender
    ORDER BY status;
  `;
  const { rows } = await p.query<PhoneNumberStatusRow>(query, [currentDate]);
  return rows;
}

export async function getLastCommunication(phoneNumber: string): Promise<{ reason: string; timestamp: Date } | false> {
  const p = getPool();
  const query = `
    SELECT reason, timestamp
    FROM whatsapp_comms
    WHERE phone_number = $1
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  const { rows } = await p.query<{ reason: string; timestamp: Date }>(query, [phoneNumber]);
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
  const query = `
    SELECT EXTRACT(EPOCH FROM MAX(timestamp))::INT AS unix_timestamp
    FROM whatsapp_messages
    WHERE group_id = $1
  `;
  const { rows } = await p.query<{ unix_timestamp: number | null }>(query, [groupId]);
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
  for (let i = 0; i < valid.length; i++) {
    const base = i * cols.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
    const m = valid[i]!;
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
  const res = await p.query(sql, values);
  // rowCount will be 0 when all conflicted; PG may not return per-row inserted count for multi-values
  // Fallback to messages.length is inaccurate when conflicts happen; try to infer using GET DIAGNOSTICS is complex here.
  // Return res.rowCount if available, else 0.
  return res.rowCount ?? 0;
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
