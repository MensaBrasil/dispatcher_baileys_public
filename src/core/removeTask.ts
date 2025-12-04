import { config as configDotenv } from "dotenv";
import logger from "../utils/logger.js";
import { sendToQueue, clearQueue, disconnect as disconnectRedis } from "../db/redis.js";
import { triggerTwilioOrRemove } from "../utils/twilio.js";
import {
  isRegularJBGroup,
  isMJBGroup,
  isNonJBGroup,
  isAJBGroup,
  isMBMulheresGroup,
  isRJBGroup,
  isOrgMBGroup,
} from "../utils/checkGroupType.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";
import { checkPhoneNumber } from "../utils/phoneCheck.js";
import { extractPhoneFromParticipant } from "../utils/jid.js";
import type { MinimalGroup } from "../utils/groups.js";

configDotenv({ path: ".env" });

const dontRemove = (process.env.DONT_REMOVE_NUMBERS ?? "").split(",").filter(Boolean);
const exceptions = (process.env.EXCEPTIONS ?? "").split(",").filter(Boolean);
const jbExceptionGroupNames = ["MB | N-SIGs Mensa Brasil", "MB | Xadrez"]; // legacy exceptions

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
  totalJBOver10MJBCount: number;
  atleast1JBOver10MJBCount: number;
  totalJBUnder10JBCount: number;
  atleast1JBUnder10JBCount: number;
  totalJBInNonJBCount: number;
  atleast1JBInNonJBCount: number;
  dontRemoveInGroupsCount: number;
  exceptionsInGroupsCount: number;
  totalNoLongerRepMinorCount: number;
  atleast1NoLongerRepMinorCount: number;
  totalNonLegalRepCount: number;
  atleast1NonLegalRepCount: number;
  totalChildPhoneMismatchCount: number;
  atleast1ChildPhoneMismatchCount: number;
};

type RemovalQueueItem = {
  type: "remove";
  registration_id: number | null;
  groupId: string;
  phone: string;
  reason: string;
  communityId?: string | null;
};

export async function removeMembersFromGroups(
  groups: MinimalGroup[],
  phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>,
): Promise<RemoveSummary> {
  const queueItems: RemovalQueueItem[] = [];

  // Summary accumulators
  const uniquePhones = new Set<string>();
  let totalInactiveCount = 0;
  const uniqueInactive = new Set<string>();
  let totalNotFoundCount = 0;
  const uniqueNotFound = new Set<string>();
  let totalJBOver10MJBCount = 0;
  const uniqueJBOver10MJB = new Set<string>();
  let totalJBUnder10JBCount = 0;
  const uniqueJBUnder10JB = new Set<string>();
  let totalJBInNonJBCount = 0;
  const uniqueJBInNonJB = new Set<string>();
  let dontRemoveInGroupsCount = 0;
  let exceptionsInGroupsCount = 0;
  let totalNoLongerRepMinorCount = 0;
  const uniqueNoLongerRepMinor = new Set<string>();
  let totalNonLegalRepCount = 0;
  const uniqueNonLegalRep = new Set<string>();
  let totalChildPhoneMismatchCount = 0;
  const uniqueChildPhoneMismatch = new Set<string>();

  for (const group of groups) {
    try {
      const groupId = group.id;
      const groupName = group.subject ?? group.name ?? "";
      const isOrgGroup = isOrgMBGroup(groupName);
      const communityId = group.announceGroup ?? null;
      const pushRemoval = (item: Omit<RemovalQueueItem, "communityId">) => queueItems.push({ ...item, communityId });
      for (const participant of group.participants) {
        if (isParticipantAdmin(participant)) continue;

        const member = extractPhoneFromParticipant(participant);
        if (!member) continue;

        if (dontRemove.includes(member)) dontRemoveInGroupsCount += 1;
        if (exceptions.includes(member)) exceptionsInGroupsCount += 1;

        const checkResult = checkPhoneNumber(phoneNumbersFromDB, member);

        if (isOrgGroup) {
          if (checkResult.found) {
            if (checkResult.status === "Inactive") {
              const shouldRemove = await triggerTwilioOrRemove(member, "mensa_inactive");
              if (shouldRemove) {
                pushRemoval({
                  type: "remove",
                  registration_id: checkResult.mb!,
                  groupId,
                  phone: member,
                  reason: "Inactive",
                });
                totalInactiveCount += 1;
                uniqueInactive.add(member);
                uniquePhones.add(member);
              }
            }
          } else {
            if (!dontRemove.includes(member)) {
              const shouldRemove = await triggerTwilioOrRemove(member, "mensa_not_found");
              if (shouldRemove) {
                pushRemoval({
                  type: "remove",
                  registration_id: null,
                  groupId,
                  phone: member,
                  reason: "Not found in DB",
                });
                totalNotFoundCount += 1;
                uniqueNotFound.add(member);
                uniquePhones.add(member);
              }
            }
          }
          continue;
        }

        if (checkResult.found && isMBMulheresGroup(groupName)) {
          if (!checkResult.has_adult_female && checkResult.gender === "Masculino") {
            pushRemoval({
              type: "remove",
              registration_id: checkResult.mb!,
              groupId,
              phone: member,
              reason: "Member is Masculine in a Feminine group.",
            });
            uniquePhones.add(member);
            continue;
          }
        }

        if (checkResult.found && isRJBGroup(groupName)) {
          if (groupName === "R.JB | Familiares de JB 12+") {
            if (checkResult.is_adult && (!checkResult.is_legal_representative || !checkResult.represents_jb_over_12)) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "Member is not legal representative of a 12+ years old member.",
              });
              if (!checkResult.is_legal_representative) {
                totalNonLegalRepCount += 1;
                uniqueNonLegalRep.add(member);
              }
              uniquePhones.add(member);
              continue;
            }

            if (checkResult.is_adult && checkResult.is_legal_representative && !checkResult.represents_minor) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "Legal representative no longer represents a minor (child is 18+).",
              });
              totalNoLongerRepMinorCount += 1;
              uniqueNoLongerRepMinor.add(member);
              uniquePhones.add(member);
              continue;
            }
          } else if (checkResult.is_adult && !checkResult.is_legal_representative) {
            pushRemoval({
              type: "remove",
              registration_id: checkResult.mb!,
              groupId,
              phone: member,
              reason: "Adult is not a legal representative in R.JB community.",
            });
            totalNonLegalRepCount += 1;
            uniqueNonLegalRep.add(member);
            uniquePhones.add(member);
            continue;
          } else if (checkResult.is_adult && checkResult.is_legal_representative && !checkResult.represents_minor) {
            pushRemoval({
              type: "remove",
              registration_id: checkResult.mb!,
              groupId,
              phone: member,
              reason: "Legal representative no longer represents a minor (child is 18+).",
            });
            totalNoLongerRepMinorCount += 1;
            uniqueNoLongerRepMinor.add(member);
            uniquePhones.add(member);
            continue;
          }
        }

        if (
          checkResult.found &&
          isRJBGroup(groupName) &&
          !checkResult.is_adult &&
          (checkResult.jb_under_10 || checkResult.jb_over_10 || checkResult.jb_over_12) &&
          !checkResult.child_phone_matches_legal_rep
        ) {
          pushRemoval({
            type: "remove",
            registration_id: checkResult.mb!,
            groupId,
            phone: member,
            reason: "Child's phone doesn't match legal representative's phone in R.JB group",
          });
          totalChildPhoneMismatchCount += 1;
          uniqueChildPhoneMismatch.add(member);
          uniquePhones.add(member);
        }

        if (checkResult.found) {
          if (
            !(checkResult.is_adult || (checkResult.jb_under_10 && checkResult.jb_over_10)) &&
            !exceptions.includes(member) &&
            !isAJBGroup(groupName)
          ) {
            if (isRegularJBGroup(groupName) && checkResult.jb_under_10) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "User is JB under 10 in JB group",
              });
              totalJBUnder10JBCount += 1;
              uniqueJBUnder10JB.add(member);
              uniquePhones.add(member);
            } else if (isMJBGroup(groupName) && checkResult.jb_over_10) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "User is JB over 10 in M.JB group",
              });
              totalJBOver10MJBCount += 1;
              uniqueJBOver10MJB.add(member);
              uniquePhones.add(member);
            } else if (
              isNonJBGroup(groupName, jbExceptionGroupNames) &&
              (checkResult.jb_under_10 || checkResult.jb_over_10)
            ) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "User is JB in non-JB group",
              });
              totalJBInNonJBCount += 1;
              uniqueJBInNonJB.add(member);
              uniquePhones.add(member);
            }
          } else if (checkResult.status === "Inactive") {
            const shouldRemove = await triggerTwilioOrRemove(member, "mensa_inactive");
            if (shouldRemove) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "Inactive",
              });
              totalInactiveCount += 1;
              uniqueInactive.add(member);
              uniquePhones.add(member);
            }
          }
        } else {
          if (!dontRemove.includes(member)) {
            const shouldRemove = await triggerTwilioOrRemove(member, "mensa_not_found");
            if (shouldRemove) {
              pushRemoval({ type: "remove", registration_id: null, groupId, phone: member, reason: "Not found in DB" });
              totalNotFoundCount += 1;
              uniqueNotFound.add(member);
              uniquePhones.add(member);
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
  return {
    totalRemoveQueueCount: queueItems.length,
    uniqueMembersAffected: uniquePhones.size,
    totalInactiveCount,
    atleast1inactiveCount: uniqueInactive.size,
    totalNotFoundCount,
    atleast1notfoundCount: uniqueNotFound.size,
    totalJBOver10MJBCount,
    atleast1JBOver10MJBCount: uniqueJBOver10MJB.size,
    totalJBUnder10JBCount,
    atleast1JBUnder10JBCount: uniqueJBUnder10JB.size,
    totalJBInNonJBCount,
    atleast1JBInNonJBCount: uniqueJBInNonJB.size,
    dontRemoveInGroupsCount,
    exceptionsInGroupsCount,
    totalNoLongerRepMinorCount,
    atleast1NoLongerRepMinorCount: uniqueNoLongerRepMinor.size,
    totalNonLegalRepCount,
    atleast1NonLegalRepCount: uniqueNonLegalRep.size,
    totalChildPhoneMismatchCount,
    atleast1ChildPhoneMismatchCount: uniqueChildPhoneMismatch.size,
  };
}

export default { removeMembersFromGroups };
