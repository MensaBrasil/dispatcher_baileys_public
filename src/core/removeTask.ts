import { config as configDotenv } from "dotenv";
import { resolveCommunications } from "../db/pgsql.js";
import { clearQueue, disconnect as disconnectRedis, sendToQueue } from "../db/redis.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";
import type { RemovalPolicy } from "../types/PolicyTypes.js";
import { checkGroupType } from "../utils/checkGroupType.js";
import type { MinimalGroup } from "../utils/groups.js";
import { extractPhoneFromParticipant, type ResolveLidToPhoneFn } from "../utils/jid.js";
import logger from "../utils/logger.js";
import { checkPhoneNumber } from "../utils/phoneCheck.js";
import { triggerTwilioOrRemove } from "../utils/twilio.js";
import { evaluatePhoneForGroup } from "../utils/whatsappEligibility.js";

configDotenv({ path: ".env" });

const EMPTY_REMOVAL_POLICY: RemovalPolicy = {
  isInvitedPhone: () => false,
  isSuspendedPhone: () => false,
};

type GroupParticipant = MinimalGroup["participants"][number];

function isParticipantAdmin(participant: GroupParticipant): boolean {
  if (participant && typeof participant === "object" && "admin" in participant) {
    const role = (participant as { admin?: unknown }).admin;
    return role === "admin" || role === "superadmin";
  }
  return false;
}

export type RemoveSummary = {
  totalRemoveQueueCount: number;
  uniqueMembersAffected: number;
  totalInactiveCount: number;
  atleast1inactiveCount: number;
  totalNotFoundCount: number;
  atleast1notfoundCount: number;
  totalIneligibleMBCount: number;
  atleast1IneligibleMBCount: number;
  totalIneligibleRJBCount: number;
  atleast1IneligibleRJBCount: number;
  invitedInGroupsCount: number;
  suspendedInGroupsCount: number;
  removalReasons: Array<{
    reason: string;
    totalOccurrences: number;
    uniqueMembers: number;
  }>;
};

type RemovalQueueItem = {
  type: "remove";
  registration_id: number | null;
  groupId: string;
  phone: string;
  reason: string;
  communityId?: string | null;
};

type RemovalOptions = {
  resolveLidToPhone?: ResolveLidToPhoneFn;
  policy?: RemovalPolicy;
};

export async function removeMembersFromGroups(
  groups: MinimalGroup[],
  phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>,
  opts: RemovalOptions = {},
): Promise<RemoveSummary> {
  const policy = opts.policy ?? EMPTY_REMOVAL_POLICY;
  const priorityQueueItems: RemovalQueueItem[] = [];
  const regularQueueItems: RemovalQueueItem[] = [];
  const resolvedCommsPhones = new Set<string>();
  const twilioDecisionByPhone = new Map<string, boolean>();
  const twilioReasonByPhone = new Map<string, string>();

  const uniquePhones = new Set<string>();
  let totalInactiveCount = 0;
  const uniqueInactive = new Set<string>();
  let totalNotFoundCount = 0;
  const uniqueNotFound = new Set<string>();
  let totalIneligibleMBCount = 0;
  const uniqueIneligibleMB = new Set<string>();
  let totalIneligibleRJBCount = 0;
  const uniqueIneligibleRJB = new Set<string>();
  let invitedInGroupsCount = 0;
  let suspendedInGroupsCount = 0;
  const removalReasonStats = new Map<string, { totalOccurrences: number; uniqueMembers: Set<string> }>();

  const shouldRemoveAfterTwilio = async (phone: string, reason: string): Promise<boolean> => {
    const cacheKey = `${phone}:${reason}`;
    const cachedDecision = twilioDecisionByPhone.get(cacheKey);
    if (cachedDecision !== undefined) {
      return cachedDecision;
    }

    const shouldRemove = await triggerTwilioOrRemove(phone, reason);
    twilioDecisionByPhone.set(cacheKey, shouldRemove);
    twilioReasonByPhone.set(phone, reason);
    return shouldRemove;
  };

  const registerRemovalReason = (phone: string, reason: string): void => {
    const existing = removalReasonStats.get(reason);
    if (existing) {
      existing.totalOccurrences += 1;
      existing.uniqueMembers.add(phone);
      return;
    }

    removalReasonStats.set(reason, {
      totalOccurrences: 1,
      uniqueMembers: new Set([phone]),
    });
  };

  for (const group of groups) {
    try {
      const groupId = group.id;
      const groupName = group.subject ?? group.name ?? "";
      const groupType = await checkGroupType(groupName);
      if (!groupType) continue;

      const communityId = group.announceGroup ?? null;
      const pushRemoval = (item: Omit<RemovalQueueItem, "communityId">, options?: { priority?: "high" | "normal" }) => {
        const queueItem = { ...item, communityId };
        if (options?.priority === "high") {
          priorityQueueItems.push(queueItem);
        } else {
          regularQueueItems.push(queueItem);
        }
      };

      for (const participant of group.participants) {
        if (isParticipantAdmin(participant)) continue;

        const member = await extractPhoneFromParticipant(participant, {
          resolveLidToPhone: opts.resolveLidToPhone,
        });
        if (!member) continue;

        const checkResult = checkPhoneNumber(phoneNumbersFromDB, member);

        const registrationId = checkResult.found && checkResult.mb !== undefined ? checkResult.mb : null;

        if (policy.isSuspendedPhone(member)) {
          suspendedInGroupsCount += 1;
          pushRemoval(
            {
              type: "remove",
              registration_id: registrationId,
              groupId,
              phone: member,
              reason: "Suspended by WhatsApp suspension policy (whatsapp_suspended_numbers).",
            },
            { priority: "high" },
          );
          registerRemovalReason(member, "Suspended by WhatsApp suspension policy (whatsapp_suspended_numbers).");
          uniquePhones.add(member);
          continue;
        }

        const isInvited = policy.isInvitedPhone(member);
        if (isInvited) {
          invitedInGroupsCount += 1;
          continue;
        }

        const evaluation = evaluatePhoneForGroup(checkResult, groupType);

        if (checkResult.found && !evaluation.shouldRemove && !resolvedCommsPhones.has(member)) {
          try {
            await resolveCommunications(member);
            resolvedCommsPhones.add(member);
          } catch (err) {
            logger.warn({ err, phone: member }, "Failed to resolve whatsapp communications for active eligible member");
          }
        }

        if (!evaluation.shouldRemove) {
          continue;
        }

        if (evaluation.waitForGracePeriod) {
          const reasonKey = checkResult.found ? "eligibility_inactive" : "eligibility_not_found";
          const shouldRemove = await shouldRemoveAfterTwilio(member, reasonKey);
          if (!shouldRemove) {
            continue;
          }
        }

        pushRemoval({
          type: "remove",
          registration_id: registrationId,
          groupId,
          phone: member,
          reason: evaluation.removalReason ?? "Not eligible for managed group",
        });
        registerRemovalReason(member, evaluation.removalReason ?? "Not eligible for managed group");

        uniquePhones.add(member);

        if (!checkResult.found) {
          totalNotFoundCount += 1;
          uniqueNotFound.add(member);
          continue;
        }

        if (evaluation.removalReason?.startsWith("Inactive ")) {
          totalInactiveCount += 1;
          uniqueInactive.add(member);
          continue;
        }

        if (groupType === "MB") {
          totalIneligibleMBCount += 1;
          uniqueIneligibleMB.add(member);
          continue;
        }

        if (groupType === "RJB") {
          totalIneligibleRJBCount += 1;
          uniqueIneligibleRJB.add(member);
        }
      }
    } catch (error) {
      logger.error({ err: error }, `Error processing group ${group.name ?? group.subject ?? group.id}`);
    }
  }

  const queueItems = [...priorityQueueItems, ...regularQueueItems];

  const queueCleared = await clearQueue("removeQueue");
  if (!queueCleared) {
    logger.error({ queue: "removeQueue" }, "Failed to clear removal queue before enqueuing new items");
    await disconnectRedis();
    throw new Error("Failed to clear removeQueue");
  }

  if (queueItems.length === 0) {
    logger.info("No removal requests generated for this cycle");
    await disconnectRedis();
    return {
      totalRemoveQueueCount: 0,
      uniqueMembersAffected: uniquePhones.size,
      totalInactiveCount,
      atleast1inactiveCount: uniqueInactive.size,
      totalNotFoundCount,
      atleast1notfoundCount: uniqueNotFound.size,
      totalIneligibleMBCount,
      atleast1IneligibleMBCount: uniqueIneligibleMB.size,
      totalIneligibleRJBCount,
      atleast1IneligibleRJBCount: uniqueIneligibleRJB.size,
      invitedInGroupsCount,
      suspendedInGroupsCount,
      removalReasons: [...removalReasonStats.entries()]
        .map(([reason, stats]) => ({
          reason,
          totalOccurrences: stats.totalOccurrences,
          uniqueMembers: stats.uniqueMembers.size,
        }))
        .sort((a, b) => b.totalOccurrences - a.totalOccurrences || a.reason.localeCompare(b.reason)),
    };
  }

  const result = await sendToQueue(queueItems, "removeQueue");
  if (result) {
    logger.info({ count: queueItems.length }, "Added removal requests to queue");
  } else {
    logger.error("Error adding remove requests to queue");
  }
  await disconnectRedis();
  return {
    totalRemoveQueueCount: queueItems.length,
    uniqueMembersAffected: uniquePhones.size,
    totalInactiveCount,
    atleast1inactiveCount: uniqueInactive.size,
    totalNotFoundCount,
    atleast1notfoundCount: uniqueNotFound.size,
    totalIneligibleMBCount,
    atleast1IneligibleMBCount: uniqueIneligibleMB.size,
    totalIneligibleRJBCount,
    atleast1IneligibleRJBCount: uniqueIneligibleRJB.size,
    invitedInGroupsCount,
    suspendedInGroupsCount,
    removalReasons: [...removalReasonStats.entries()]
      .map(([reason, stats]) => ({
        reason,
        totalOccurrences: stats.totalOccurrences,
        uniqueMembers: stats.uniqueMembers.size,
      }))
      .sort((a, b) => b.totalOccurrences - a.totalOccurrences || a.reason.localeCompare(b.reason)),
  };
}

export default { removeMembersFromGroups };
