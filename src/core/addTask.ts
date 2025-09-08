import logger from "../utils/logger.js";
import { getWhatsappQueue, closePool } from "../db/pgsql.js";
import { sendToQueue, clearQueue, disconnect as disconnectRedis } from "../db/redis.js";
import { checkGroupType } from "../utils/checkGroupType.js";
import type { GroupType } from "../types/DBTypes.js";

type MinimalGroup = { id: string; subject?: string; name?: string };

export type AddSummary = {
  totalPendingAdditionsCount: number;
  atleast1PendingAdditionsCount: number; // unique registrations awaiting addition
};

export async function addMembersToGroups(groups: MinimalGroup[]): Promise<AddSummary> {
  const queueItems: Array<{
    type: "add";
    request_id: number;
    registration_id: number;
    group_id: string;
    group_type: GroupType | null;
  }> = [];

  // Track totals for the cycle
  let totalPending = 0;
  const uniqueRegistrations = new Set<number>();

  for (const group of groups) {
    const groupId = group.id;
    const groupName = group.subject ?? group.name ?? "";
    try {
      const queue = await getWhatsappQueue(groupId);

      for (const request of queue) {
        try {
          const item = {
            type: "add" as const,
            request_id: request.request_id,
            registration_id: request.registration_id,
            group_id: groupId,
            group_type: await checkGroupType(groupName),
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
    } catch (error: unknown) {
      logger.error({ err: error, groupId, groupName }, `Error adding members to group ${groupName}`);
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
  };
}

export default { addMembersToGroups };
