import logger from "../utils/logger.js";
import { sendToQueue, clearQueue, disconnect as disconnectRedis } from "../db/redis.js";
import { triggerTwilioOrRemove } from "../utils/twilio.js";
import { isRegularJBGroup, isMJBGroup, isNonJBGroup, isAJBGroup, isMBMulheresGroup } from "../utils/checkGroupType.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";
import { checkPhoneNumber } from "../utils/phoneCheck.js";

const dontRemove = (process.env.DONT_REMOVE_NUMBERS ?? "").split(",").filter(Boolean);
const exceptions = (process.env.EXCEPTIONS ?? "").split(",").filter(Boolean);
const jbExceptionGroupNames = ["MB | N-SIGs Mensa Brasil", "MB | Xadrez"]; // legacy exceptions

type MinimalParticipant = { id?: { user?: string } } | { user?: string } | { id: string } | string;
type MinimalGroup = {
  id: string;
  subject?: string;
  name?: string;
  participants: MinimalParticipant[];
  announceGroup?: string | null;
};

function hasIdString(x: unknown): x is { id: string } {
  return typeof x === "object" && x !== null && "id" in x && typeof (x as { id: unknown }).id === "string";
}

function hasIdUser(x: unknown): x is { id: { user?: string } } {
  return (
    typeof x === "object" &&
    x !== null &&
    "id" in x &&
    typeof (x as { id: unknown }).id === "object" &&
    (x as { id: { user?: unknown } }).id !== null &&
    "user" in (x as { id: { user?: unknown } }).id!
  );
}

function hasUser(x: unknown): x is { user?: string } {
  return typeof x === "object" && x !== null && "user" in x;
}

function extractUser(p: MinimalParticipant): string | null {
  if (typeof p === "string") return p;
  if (hasIdString(p)) {
    const jid = p.id;
    return jid.split("@")[0] ?? null;
  }
  if (hasIdUser(p)) {
    return String(p.id.user);
  }
  if (hasUser(p)) {
    return String(p.user);
  }
  return null;
}

export async function removeMembersFromGroups(
  groups: MinimalGroup[],
  phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>,
): Promise<void> {
  const queueItems: Array<{
    type: "remove";
    registration_id: number | null;
    groupId: string;
    phone: string;
    reason: string;
    communityId?: string | null;
  }> = [];

  for (const group of groups) {
    try {
      const groupId = group.id;
      const groupName = group.subject ?? group.name ?? "";
      const groupMembers = group.participants.map(extractUser).filter((x): x is string => Boolean(x));

      for (const member of groupMembers) {
        const checkResult = checkPhoneNumber(phoneNumbersFromDB, member);

        // MB | Mulheres rule
        if (checkResult.found && isMBMulheresGroup(groupName) && checkResult.gender === "Masculino") {
          queueItems.push({
            type: "remove",
            registration_id: checkResult.mb!,
            groupId,
            phone: member,
            reason: "Member is Masculine in a Feminine group.",
          });
          continue;
        }

        // Custom legal representative rule (R.JB | Familiares de JB 12+)
        if (checkResult.found && groupName === "R.JB | Familiares de JB 12+" && !checkResult.is_legal_representative) {
          // Without DB helper check here; this replicates minimum rule that non-legal reps are removed
          queueItems.push({
            type: "remove",
            registration_id: checkResult.mb!,
            groupId,
            phone: member,
            reason: "Member is not legal representative of a 12+ years old member.",
          });
          continue;
        }

        if (checkResult.found) {
          if (
            !(checkResult.is_adult || (checkResult.jb_under_10 && checkResult.jb_over_10)) &&
            !exceptions.includes(member) &&
            !isAJBGroup(groupName)
          ) {
            if (isRegularJBGroup(groupName) && checkResult.jb_under_10) {
              queueItems.push({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "User is JB under 10 in JB group",
              });
            } else if (isMJBGroup(groupName) && checkResult.jb_over_10) {
              queueItems.push({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "User is JB over 10 in M.JB group",
              });
            } else if (
              isNonJBGroup(groupName, jbExceptionGroupNames) &&
              (checkResult.jb_under_10 || checkResult.jb_over_10)
            ) {
              queueItems.push({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "User is JB in non-JB group",
              });
            }
          } else if (checkResult.status === "Inactive") {
            const shouldRemove = await triggerTwilioOrRemove(member, "mensa_inactive");
            if (shouldRemove) {
              queueItems.push({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "Inactive",
                communityId: group.announceGroup ?? null,
              });
            }
          }
        } else {
          if (!dontRemove.includes(member)) {
            const shouldRemove = await triggerTwilioOrRemove(member, "mensa_not_found");
            if (shouldRemove) {
              queueItems.push({
                type: "remove",
                registration_id: null,
                groupId,
                phone: member,
                reason: "Not found in DB",
                communityId: group.announceGroup ?? null,
              });
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, `Error processing group ${group.name ?? group.subject ?? group.id}`);
    }
  }

  await clearQueue("removeQueue");
  const result = await sendToQueue(queueItems, "removeQueue");
  if (result) {
    logger.info({ count: queueItems.length }, "Added removal requests to queue");
  } else {
    logger.error("Error adding remove requests to queue");
  }
  await disconnectRedis();
}

export default { removeMembersFromGroups };
