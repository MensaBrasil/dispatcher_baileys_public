import { config as configDotenv } from "dotenv";
import logger from "../utils/logger.js";
import { getWhatsappQueue, getRegistrationFlags, closePool } from "../db/pgsql.js";
import { sendToQueue, clearQueue, disconnect as disconnectRedis } from "../db/redis.js";
import { checkGroupType } from "../utils/checkGroupType.js";
import type { GroupType } from "../types/DBTypes.js";

configDotenv({ path: ".env" });

type MinimalGroup = { id: string; subject?: string; name?: string };

export type AddSummary = {
  totalPendingAdditionsCount: number;
  atleast1PendingAdditionsCount: number; // unique registrations awaiting addition
  blockedRequestsCount: number;
  blockedRegistrationsCount: number;
};

const blockedRegistrations = new Set(
  (process.env.BLOCKED_MB ?? "")
    .split(",")
    .map((id) => Number.parseInt(id.trim(), 10))
    .filter((id) => Number.isFinite(id)),
);

export async function addMembersToGroups(groups: MinimalGroup[]): Promise<AddSummary> {
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
  let blockedRequestsCount = 0;
  const uniqueBlockedRegistrations = new Set<number>();

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

  for (const entry of queuesByGroup) {
    const { groupId, groupName, groupType, requests } = entry;
    for (const request of requests) {
      try {
        if (blockedRegistrations.has(request.registration_id)) {
          blockedRequestsCount += 1;
          uniqueBlockedRegistrations.add(request.registration_id);
          logger.info(
            { registration_id: request.registration_id, groupId, groupName },
            "Registration blocked from addition; skipping request",
          );
          continue;
        }

        const flags = registrationFlags.get(request.registration_id);
        if (!flags) {
          logger.warn(
            { registration_id: request.registration_id, groupId, groupName },
            "Registration not found when validating age/terms; skipping add",
          );
          continue;
        }

        if (flags.jb_under_13) {
          logger.info(
            { registration_id: request.registration_id, groupId, groupName },
            "Under 13 not allowed in WhatsApp groups; skipping add",
          );
          continue;
        }

        if (groupType === "JB") {
          if (!flags.jb_13_to_17) {
            logger.info(
              { registration_id: request.registration_id, groupId, groupName },
              "Registration not in JB 13-17 range; skipping add",
            );
            continue;
          }
          if (!flags.has_accepted_terms) {
            logger.info(
              { registration_id: request.registration_id, groupId, groupName },
              "Missing gov.br authorization; skipping add",
            );
            continue;
          }
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
    blockedRequestsCount,
    blockedRegistrationsCount: uniqueBlockedRegistrations.size,
  };
}

export default { addMembersToGroups };
