import { config as configDotenv } from "dotenv";
import { Pool } from "pg";
import type { DBGroupRequest, GroupType, WhatsAppWorker } from "../types/DBTypes.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";
import type { ActiveWhatsappPolicy } from "../types/PolicyTypes.js";
import logger from "../utils/logger.js";

configDotenv({ path: ".env" });

// Shared connection pool
let pool: Pool | undefined;

type PgPrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

type PgPreflightTableSpec = {
  tableName: string;
  requiredPrivileges: PgPrivilege[];
};

type PreflightFailure = {
  service: "postgres";
  table: string;
  message: string;
  missingPrivileges?: PgPrivilege[];
};

const POSTGRES_PREFLIGHT_TABLE_SPECS: PgPreflightTableSpec[] = [
  { tableName: "registration", requiredPrivileges: ["SELECT"] },
  { tableName: "membership_payments", requiredPrivileges: ["SELECT"] },
  { tableName: "legal_representatives", requiredPrivileges: ["SELECT"] },
  { tableName: "whatsapp_auth_terms", requiredPrivileges: ["SELECT"] },
  { tableName: "phones", requiredPrivileges: ["SELECT"] },
  { tableName: "group_requests", requiredPrivileges: ["SELECT", "UPDATE"] },
  { tableName: "whatsapp_invited_numbers", requiredPrivileges: ["SELECT"] },
  { tableName: "whatsapp_suspended_numbers", requiredPrivileges: ["SELECT"] },
  { tableName: "whatsapp_comms", requiredPrivileges: ["SELECT", "INSERT", "UPDATE"] },
  { tableName: "member_groups", requiredPrivileges: ["SELECT", "INSERT", "UPDATE"] },
  { tableName: "group_list", requiredPrivileges: ["INSERT", "DELETE"] },
  { tableName: "whatsapp_lid_mappings", requiredPrivileges: ["INSERT", "UPDATE"] },
];

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

async function getCurrentSchemaName(): Promise<string> {
  const p = getPool();
  const { rows } = await p.query<{ schema_name: string | null }>("SELECT current_schema() AS schema_name");
  return rows[0]?.schema_name ?? "public";
}

async function tableExists(schemaName: string, tableName: string): Promise<boolean> {
  const p = getPool();
  const query = `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name = $2
    ) AS exists
  `;
  const { rows } = await p.query<{ exists: boolean }>(query, [schemaName, tableName]);
  return Boolean(rows[0]?.exists);
}

async function hasTablePrivilege(schemaName: string, tableName: string, privilege: PgPrivilege): Promise<boolean> {
  const p = getPool();
  const query = `
    SELECT has_table_privilege(current_user, format('%I.%I', $1::text, $2::text), $3::text) AS allowed
  `;
  const { rows } = await p.query<{ allowed: boolean }>(query, [schemaName, tableName, privilege]);
  return Boolean(rows[0]?.allowed);
}

export async function runPostgresPreflight(): Promise<void> {
  logger.info({ service: "postgres" }, "[preflight] starting postgres checks");

  const p = getPool();

  try {
    await p.query("SELECT 1");
  } catch (err) {
    logger.error({ err, service: "postgres" }, "[preflight] postgres connectivity check failed");
    throw new Error("Startup pre-flight failed: Postgres connectivity check failed.", { cause: err });
  }

  let schemaName: string;
  try {
    schemaName = await getCurrentSchemaName();
  } catch (err) {
    logger.error({ err, service: "postgres" }, "[preflight] failed to resolve current schema");
    throw new Error("Startup pre-flight failed: Could not determine Postgres schema.", { cause: err });
  }

  const failures: PreflightFailure[] = [];

  for (const spec of POSTGRES_PREFLIGHT_TABLE_SPECS) {
    try {
      const exists = await tableExists(schemaName, spec.tableName);
      if (!exists) {
        failures.push({
          service: "postgres",
          table: spec.tableName,
          message: `Table "${spec.tableName}" not found in schema "${schemaName}".`,
        });
        continue;
      }

      const missingPrivileges: PgPrivilege[] = [];
      for (const privilege of spec.requiredPrivileges) {
        const allowed = await hasTablePrivilege(schemaName, spec.tableName, privilege);
        if (!allowed) missingPrivileges.push(privilege);
      }

      if (missingPrivileges.length > 0) {
        failures.push({
          service: "postgres",
          table: spec.tableName,
          missingPrivileges,
          message: `Missing privileges on "${schemaName}.${spec.tableName}": ${missingPrivileges.join(", ")}.`,
        });
      }
    } catch (err) {
      failures.push({
        service: "postgres",
        table: spec.tableName,
        message: `Failed to validate "${schemaName}.${spec.tableName}".`,
      });
      logger.error(
        { err, service: "postgres", table: spec.tableName },
        "[preflight] postgres table validation errored",
      );
    }
  }

  if (failures.length > 0) {
    logger.error(
      { service: "postgres", schemaName, failures },
      "[preflight] postgres schema and privilege validation failed",
    );
    throw new Error("Startup pre-flight failed: Postgres schema and privilege validation failed.");
  }

  logger.info(
    { service: "postgres", schemaName, tablesChecked: POSTGRES_PREFLIGHT_TABLE_SPECS.length },
    "[preflight] postgres checks passed",
  );
}

export async function getWhatsappQueue(group_id: string): Promise<DBGroupRequest[]> {
  const p = getPool();
  const query = `
    WITH latest_requests AS (
      SELECT
        group_requests.id AS request_id,
        group_requests.registration_id,
        group_requests.group_id,
        COALESCE(group_requests.no_of_attempts, 0) AS no_of_attempts,
        group_requests.last_attempt,
        group_requests.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY group_requests.registration_id, group_requests.group_id
          ORDER BY
            group_requests.last_attempt DESC NULLS LAST,
            group_requests.updated_at DESC NULLS LAST,
            group_requests.id DESC
        ) AS request_rank
      FROM
        group_requests
      WHERE
        group_requests.group_id = $1
        AND group_requests.fulfilled = FALSE
        AND (
          group_requests.no_of_attempts < 3
          OR group_requests.no_of_attempts IS NULL
        )
    )
    SELECT
      request_id,
      registration_id,
      group_id,
      no_of_attempts,
      last_attempt
    FROM
      latest_requests
    WHERE
      request_rank = 1
      AND (last_attempt < NOW() - INTERVAL '1 DAY' OR last_attempt IS NULL)
    ORDER BY
      registration_id ASC,
      request_id ASC
  `;
  const { rows } = await p.query<DBGroupRequest>(query, [group_id]);
  return rows;
}

export async function getUnfulfilledGroupRequestsForScan(group_id: string): Promise<DBGroupRequest[]> {
  const p = getPool();
  const query = `
    SELECT
      group_requests.id AS request_id,
      group_requests.registration_id,
      group_requests.group_id,
      COALESCE(group_requests.no_of_attempts, 0) AS no_of_attempts,
      group_requests.last_attempt
    FROM
      group_requests
    WHERE
      group_id = $1
      AND fulfilled = FALSE
  `;
  const { rows } = await p.query<DBGroupRequest>(query, [group_id]);
  return rows;
}

export async function getPhoneNumbersWithStatus(): Promise<PhoneNumberStatusRow[]> {
  const p = getPool();
  const currentDate = new Date().toISOString().split("T")[0];
  const query = `
    WITH MaxExpirationDates AS (
      SELECT registration_id, MAX(expiration_date) AS max_expiration_date
      FROM membership_payments
      GROUP BY registration_id
    ), RegistrationStatus AS (
      SELECT
        r.registration_id,
        DATE_PART('year', AGE(r.birth_date))::int AS member_age_years,
        CASE
          WHEN med.max_expiration_date >= $1::date
            AND COALESCE(r.transferred, FALSE) = FALSE
            AND COALESCE(r.deceased, FALSE) = FALSE
            AND COALESCE(r.expelled, FALSE) = FALSE
            AND NOT (
              r.suspended_until IS NOT NULL
              AND r.suspended_until >= $1::date
            )
          THEN TRUE
          ELSE FALSE
        END AS is_active
      FROM registration r
      LEFT JOIN MaxExpirationDates med ON r.registration_id = med.registration_id
    ), PhoneNumbers AS (
      SELECT
        p.phone_number AS phone_number,
        p.registration_id AS registration_id,
        CASE
          WHEN rs.is_active THEN 'Active'
          ELSE 'Inactive'
        END AS status,
        'member'::text AS phone_role,
        rs.member_age_years,
        (
          SELECT COUNT(*)::int
          FROM phones mp
          WHERE mp.registration_id = p.registration_id
            AND NULLIF(BTRIM(mp.phone_number), '') IS NOT NULL
        ) AS managed_phone_count,
        FALSE AS is_legal_representative,
        CASE
          WHEN rs.is_active
            AND rs.member_age_years >= 18
          THEN TRUE
          ELSE FALSE
        END AS is_managed_mb_eligible,
        FALSE AS is_managed_rjb_eligible
      FROM phones p
      LEFT JOIN RegistrationStatus rs ON p.registration_id = rs.registration_id
      UNION ALL
      SELECT
        lr.phone AS phone_number,
        lr.registration_id,
        CASE
          WHEN rs.is_active THEN 'Active'
          ELSE 'Inactive'
        END AS status,
        'legal_rep'::text AS phone_role,
        rs.member_age_years,
        (
          SELECT COUNT(*)::int
          FROM legal_representatives mlr
          WHERE mlr.registration_id = lr.registration_id
            AND NULLIF(BTRIM(mlr.phone), '') IS NOT NULL
        ) AS managed_phone_count,
        TRUE AS is_legal_representative,
        FALSE AS is_managed_mb_eligible,
        CASE
          WHEN rs.is_active
            AND rs.member_age_years <= 17
          THEN TRUE
          ELSE FALSE
        END AS is_managed_rjb_eligible
      FROM legal_representatives lr
      LEFT JOIN RegistrationStatus rs ON lr.registration_id = rs.registration_id
    )
    SELECT
      phone_number,
      registration_id,
      status,
      phone_role,
      member_age_years,
      managed_phone_count,
      BOOL_OR(is_legal_representative) AS is_legal_representative,
      BOOL_OR(is_managed_mb_eligible) AS is_managed_mb_eligible,
      BOOL_OR(is_managed_rjb_eligible) AS is_managed_rjb_eligible
    FROM PhoneNumbers
    WHERE phone_number IS NOT NULL
    GROUP BY phone_number, registration_id, status, phone_role, member_age_years, managed_phone_count
    ORDER BY status, phone_number;
  `;
  const { rows } = await p.query<PhoneNumberStatusRow>(query, [currentDate]);
  return rows;
}

export type RegistrationPhoneLookupRow = {
  phone_number: string;
  registration_id: number;
  name: string | null;
  source: "member" | "legal_rep" | "legal_rep_alternative";
};

export async function getRegistrationPhoneLookupRows(): Promise<RegistrationPhoneLookupRow[]> {
  const p = getPool();
  const query = `
    SELECT
      p.phone_number,
      p.registration_id,
      r.name,
      'member'::text AS source
    FROM phones p
    LEFT JOIN registration r ON r.registration_id = p.registration_id

    UNION ALL

    SELECT
      lr.phone AS phone_number,
      lr.registration_id,
      r.name,
      'legal_rep'::text AS source
    FROM legal_representatives lr
    LEFT JOIN registration r ON r.registration_id = lr.registration_id
    WHERE lr.phone IS NOT NULL

    UNION ALL

    SELECT
      lr.alternative_phone AS phone_number,
      lr.registration_id,
      r.name,
      'legal_rep_alternative'::text AS source
    FROM legal_representatives lr
    LEFT JOIN registration r ON r.registration_id = lr.registration_id
    WHERE lr.alternative_phone IS NOT NULL
  `;

  const { rows } = await p.query<RegistrationPhoneLookupRow>(query);
  return rows;
}

export type RegistrationFlags = {
  registration_id: number;
  is_active: boolean;
  is_adult: boolean;
  is_minor: boolean;
  has_member_phone: boolean;
  has_legal_rep_phone: boolean;
  member_phone_count: number;
  legal_rep_phone_count: number;
};

export async function getRegistrationFlags(registrationIds: number[]): Promise<Map<number, RegistrationFlags>> {
  const p = getPool();
  if (registrationIds.length === 0) return new Map();
  const query = `
    SELECT
      r.registration_id,
      CASE
        WHEN med.max_expiration_date >= CURRENT_DATE
          AND COALESCE(r.transferred, FALSE) = FALSE
          AND COALESCE(r.deceased, FALSE) = FALSE
          AND COALESCE(r.expelled, FALSE) = FALSE
          AND NOT (
            r.suspended_until IS NOT NULL
            AND r.suspended_until >= CURRENT_DATE
          )
        THEN TRUE
        ELSE FALSE
      END AS is_active,
      CASE WHEN DATE_PART('year', AGE(r.birth_date)) >= 18 THEN TRUE ELSE FALSE END AS is_adult,
      CASE WHEN DATE_PART('year', AGE(r.birth_date)) <= 17 THEN TRUE ELSE FALSE END AS is_minor,
      EXISTS (
        SELECT 1
        FROM phones p
        WHERE p.registration_id = r.registration_id
          AND NULLIF(BTRIM(p.phone_number), '') IS NOT NULL
      ) AS has_member_phone,
      (
        SELECT COUNT(*)::int
        FROM phones p
        WHERE p.registration_id = r.registration_id
          AND NULLIF(BTRIM(p.phone_number), '') IS NOT NULL
      ) AS member_phone_count,
      EXISTS (
        SELECT 1
        FROM legal_representatives lr
        WHERE lr.registration_id = r.registration_id
          AND NULLIF(BTRIM(lr.phone), '') IS NOT NULL
      ) AS has_legal_rep_phone,
      (
        SELECT COUNT(*)::int
        FROM legal_representatives lr
        WHERE lr.registration_id = r.registration_id
          AND NULLIF(BTRIM(lr.phone), '') IS NOT NULL
      ) AS legal_rep_phone_count
    FROM registration r
    LEFT JOIN (
      SELECT registration_id, MAX(expiration_date) AS max_expiration_date
      FROM membership_payments
      GROUP BY registration_id
    ) med ON med.registration_id = r.registration_id
    WHERE r.registration_id = ANY($1)
  `;
  const { rows } = await p.query<RegistrationFlags>(query, [registrationIds]);
  const flags = new Map<number, RegistrationFlags>();
  for (const row of rows) {
    flags.set(row.registration_id, row);
  }
  return flags;
}

export async function getActiveWhatsappPolicy(): Promise<ActiveWhatsappPolicy> {
  const p = getPool();
  const invitedQuery = `
    SELECT phone_number
    FROM whatsapp_invited_numbers
    WHERE invited_until IS NULL OR invited_until >= NOW()
  `;
  const suspendedQuery = `
    SELECT phone_number, registration_id
    FROM whatsapp_suspended_numbers
    WHERE suspended_until IS NULL OR suspended_until >= NOW()
  `;

  const [invitedResult, suspendedResult] = await Promise.all([
    p.query<{ phone_number: string | null }>(invitedQuery),
    p.query<{ phone_number: string | null; registration_id: number | null }>(suspendedQuery),
  ]);

  const invitedPhones = new Set<string>();
  for (const row of invitedResult.rows) {
    const phone = row.phone_number?.trim();
    if (phone) invitedPhones.add(phone);
  }

  const suspendedPhones = new Set<string>();
  const suspendedRegistrationIds = new Set<number>();
  for (const row of suspendedResult.rows) {
    const phone = row.phone_number?.trim();
    if (phone) suspendedPhones.add(phone);
    if (row.registration_id !== null && Number.isFinite(row.registration_id)) {
      suspendedRegistrationIds.add(row.registration_id);
    }
  }

  return {
    invitedPhones: [...invitedPhones],
    suspendedPhones: [...suspendedPhones],
    suspendedRegistrationIds: [...suspendedRegistrationIds],
  };
}

export async function getLastCommunication(
  phoneNumber: string,
  reason?: string,
): Promise<{ reason: string; timestamp: Date } | false> {
  const p = getPool();
  const query = `
    SELECT reason, timestamp
    FROM whatsapp_comms
    WHERE phone_number = $1
      AND status = 'unresolved'
      AND ($2::text IS NULL OR reason = $2)
    ORDER BY timestamp DESC
    LIMIT 1
  `;
  const { rows } = await p.query<{ reason: string; timestamp: Date }>(query, [phoneNumber, reason ?? null]);
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

export async function getManagedGroupPhoneNumbers(registration_id: number, groupType: GroupType): Promise<string[]> {
  const p = getPool();
  const query =
    groupType === "MB"
      ? `SELECT phone_number AS phone FROM phones WHERE registration_id = $1`
      : `SELECT phone AS phone FROM legal_representatives WHERE registration_id = $1`;

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
      for (const [i, group] of groups.entries()) {
        const base = i * 2;
        placeholders.push(`($${base + 1}, $${base + 2})`);
        values.push(group.group_name, group.group_id);
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

export default { getWhatsappQueue, closePool };

/**
 * Retrieves all WhatsApp workers (return only stable columns).
 */
export async function getAllWhatsAppWorkers(): Promise<WhatsAppWorker[]> {
  const query = "SELECT id, worker_phone FROM whatsapp_workers;";
  const { rows } = await getPool().query<WhatsAppWorker>(query);
  return rows;
}

export async function getAllWhatsAppAuthorizations(): Promise<
  Array<{ phone_number: string | null; worker_id: number | null }>
> {
  const query = `
    SELECT phone_number, worker_id
    FROM whatsapp_authorization
  `;
  const { rows } = await getPool().query<{ phone_number: string | null; worker_id: number | null }>(query);
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
