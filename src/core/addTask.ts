import {
  closePool,
  getAllWhatsAppAuthorizations,
  getAllWhatsAppWorkers,
  getManagedGroupPhoneNumbers,
  getRegistrationFlags,
  getWhatsappQueue,
} from "../db/pgsql.js";
import { clearQueue, disconnect as disconnectRedis, sendToQueue } from "../db/redis.js";
import type { GroupType } from "../types/DBTypes.js";
import type { AddPolicy } from "../types/PolicyTypes.js";
import { checkGroupType } from "../utils/checkGroupType.js";
import logger from "../utils/logger.js";
import {
  buildAuthorizationLookup,
  buildSuspendedPhoneLookup,
  isPhoneInSuspendedLookup,
  resolveAuthorizedWorkersForPhone,
} from "../utils/phoneMatch.js";
import { isEligibleRegistrationForGroup } from "../utils/whatsappEligibility.js";

type MinimalGroup = { id: string; subject?: string; name?: string };

export type AddSummary = {
  totalPendingAdditionsCount: number;
  atleast1PendingAdditionsCount: number; // unique registrations awaiting addition
  suspendedRequestsCount: number;
  suspendedRegistrationsCount: number;
  ignoredRequestsCount: number;
  ignoredRegistrationsCount: number;
};

const EMPTY_ADD_POLICY: AddPolicy = {
  suspendedRegistrationIds: new Set<number>(),
  suspendedPhones: [],
};

function parseEnvCsvNumberSet(name: string): Set<number> {
  const raw = process.env[name];
  if (!raw?.trim()) return new Set<number>();

  return new Set(
    raw
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter(Number.isFinite),
  );
}

const IGNORED_ADD_REGISTRATION_IDS = parseEnvCsvNumberSet("IGNORED_ADD_REGISTRATION_IDS");

export async function addMembersToGroups(
  groups: MinimalGroup[],
  policy: AddPolicy = EMPTY_ADD_POLICY,
): Promise<AddSummary> {
  const queueItems: Array<{
    type: "add";
    request_id: number;
    registration_id: number;
    group_id: string;
    group_type: GroupType | null;
  }> = [];

  const queuesByGroup: Array<{
    groupId: string;
    groupName: string;
    groupType: GroupType | null;
    requests: Awaited<ReturnType<typeof getWhatsappQueue>>;
  }> = [];
  const registrationIds = new Set<number>();

  // Track totals for the cycle
  let totalPending = 0;
  const uniqueRegistrations = new Set<number>();
  let suspendedRequestsCount = 0;
  const uniqueSuspendedRegistrations = new Set<number>();
  let ignoredRequestsCount = 0;
  const uniqueIgnoredRegistrations = new Set<number>();

  for (const group of groups) {
    const groupId = group.id;
    const groupName = group.subject ?? group.name ?? "";
    try {
      const queue = await getWhatsappQueue(groupId);
      const groupType = await checkGroupType(groupName);
      queuesByGroup.push({ groupId, groupName, groupType, requests: queue });
      for (const request of queue) {
        registrationIds.add(request.registration_id);
      }
    } catch (error: unknown) {
      logger.error({ err: error, groupId, groupName }, `Error adding members to group ${groupName}`);
    }
  }

  const registrationFlags = await getRegistrationFlags([...registrationIds]);
  const [workers, authorizations] = await Promise.all([getAllWhatsAppWorkers(), getAllWhatsAppAuthorizations()]);
  const authorizationLookup = buildAuthorizationLookup(workers, authorizations);
  const suspendedPhoneLookup = buildSuspendedPhoneLookup(policy.suspendedPhones);
  const managedPhonesByRegistrationAndGroupType = new Map<string, string[]>();

  for (const entry of queuesByGroup) {
    const { groupId, groupName, groupType, requests } = entry;
    for (const request of requests) {
      try {
        if (IGNORED_ADD_REGISTRATION_IDS.has(request.registration_id)) {
          ignoredRequestsCount += 1;
          uniqueIgnoredRegistrations.add(request.registration_id);
          logger.info(
            { registration_id: request.registration_id, groupId, groupName },
            "Registration is listed in IGNORED_ADD_REGISTRATION_IDS; skipping enqueue",
          );
          continue;
        }

        if (policy.suspendedRegistrationIds.has(request.registration_id)) {
          suspendedRequestsCount += 1;
          uniqueSuspendedRegistrations.add(request.registration_id);
          logger.info(
            { registration_id: request.registration_id, groupId, groupName },
            "Registration is suspended and blocked from addition; skipping request",
          );
          continue;
        }

        const flags = registrationFlags.get(request.registration_id);
        if (!flags || !groupType) {
          logger.warn(
            { registration_id: request.registration_id, groupId, groupName },
            "Registration or managed group type not found when validating add; skipping add",
          );
          continue;
        }

        if (
          !isEligibleRegistrationForGroup(
            {
              registrationId: flags.registration_id,
              isActive: flags.is_active,
              isAdult: flags.is_adult,
              isMinor: flags.is_minor,
              hasMemberPhone: flags.has_member_phone,
              hasLegalRepPhone: flags.has_legal_rep_phone,
              memberPhoneCount: flags.member_phone_count,
              legalRepPhoneCount: flags.legal_rep_phone_count,
            },
            groupType,
          )
        ) {
          logger.info(
            { registration_id: request.registration_id, groupId, groupName, groupType },
            "Registration is not eligible for managed group type; skipping add",
          );
          continue;
        }

        const managedPhoneCacheKey = `${request.registration_id}:${groupType}`;
        let managedPhones = managedPhonesByRegistrationAndGroupType.get(managedPhoneCacheKey);
        if (!managedPhones) {
          managedPhones = await getManagedGroupPhoneNumbers(request.registration_id, groupType);
          managedPhonesByRegistrationAndGroupType.set(managedPhoneCacheKey, managedPhones);
        }

        const hasEligibleManagedPhone = managedPhones.some((phone) => {
          if (isPhoneInSuspendedLookup(phone, suspendedPhoneLookup)) {
            return false;
          }

          return resolveAuthorizedWorkersForPhone(phone, authorizationLookup).length > 0;
        });
        if (!hasEligibleManagedPhone) {
          logger.info(
            { registration_id: request.registration_id, groupId, groupName, groupType },
            "Registration has no authorized, non-suspended managed phone for this group type; skipping add",
          );
          continue;
        }

        const item = {
          type: "add" as const,
          request_id: request.request_id,
          registration_id: request.registration_id,
          group_id: groupId,
          group_type: groupType,
        };
        queueItems.push(item);
        totalPending += 1;
        uniqueRegistrations.add(request.registration_id);
      } catch (error: unknown) {
        logger.error(
          { err: error, registration_id: request.registration_id, groupId },
          `Error preparing add request for group ${groupId}`,
        );
      }
    }
  }

  await clearQueue("addQueue");
  const result = await sendToQueue(queueItems, "addQueue");
  if (result) {
    logger.info({ count: queueItems.length }, "Added addition requests to queue");
  } else {
    logger.error("Error adding requests to queue");
  }

  await disconnectRedis();
  await closePool();
  return {
    totalPendingAdditionsCount: totalPending,
    atleast1PendingAdditionsCount: uniqueRegistrations.size,
    suspendedRequestsCount,
    suspendedRegistrationsCount: uniqueSuspendedRegistrations.size,
    ignoredRequestsCount,
    ignoredRegistrationsCount: uniqueIgnoredRegistrations.size,
  };
}

export default { addMembersToGroups };
