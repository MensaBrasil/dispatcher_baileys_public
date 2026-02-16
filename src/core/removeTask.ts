import { config as configDotenv } from "dotenv";
import logger from "../utils/logger.js";
import { sendToQueue, clearQueue, disconnect as disconnectRedis } from "../db/redis.js";
import { triggerTwilioOrRemove } from "../utils/twilio.js";
import {
  isRegularJBGroup,
  isNonJBGroup,
  isAJBGroup,
  isMBMulheresGroup,
  isRJBGroup,
  isOrgMBGroup,
} from "../utils/checkGroupType.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";
import { checkPhoneNumber } from "../utils/phoneCheck.js";
import { extractPhoneFromParticipant, type ResolveLidToPhoneFn } from "../utils/jid.js";
import type { MinimalGroup } from "../utils/groups.js";
import { buildProtectedPhoneMatcher, parsePhoneCsv } from "../utils/phoneList.js";

configDotenv({ path: ".env" });

const isDontRemoveNumber = buildProtectedPhoneMatcher(process.env.DONT_REMOVE_NUMBERS);
const exceptions = new Set(parsePhoneCsv(process.env.EXCEPTIONS));
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
  totalUnder13Count: number;
  atleast1Under13Count: number;
  totalMissingGovTermsCount: number;
  atleast1MissingGovTermsCount: number;
  totalJBInNonJBCount: number;
  atleast1JBInNonJBCount: number;
  totalAdultNotLegalRepJBCount: number;
  atleast1AdultNotLegalRepJBCount: number;
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

type RemovalOptions = {
  resolveLidToPhone?: ResolveLidToPhoneFn;
};

export async function removeMembersFromGroups(
  groups: MinimalGroup[],
  phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>,
  opts: RemovalOptions = {},
): Promise<RemoveSummary> {
  const queueItems: RemovalQueueItem[] = [];

  // Summary accumulators
  const uniquePhones = new Set<string>();
  let totalInactiveCount = 0;
  const uniqueInactive = new Set<string>();
  let totalNotFoundCount = 0;
  const uniqueNotFound = new Set<string>();
  let totalUnder13Count = 0;
  const uniqueUnder13 = new Set<string>();
  let totalMissingGovTermsCount = 0;
  const uniqueMissingGovTerms = new Set<string>();
  let totalJBInNonJBCount = 0;
  const uniqueJBInNonJB = new Set<string>();
  let totalAdultNotLegalRepJBCount = 0;
  const uniqueAdultNotLegalRepJB = new Set<string>();
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

        const member = await extractPhoneFromParticipant(participant, {
          resolveLidToPhone: opts.resolveLidToPhone,
        });
        if (!member) continue;

        const isDontRemove = isDontRemoveNumber(member);
        const isException = exceptions.has(member);
        if (isDontRemove) dontRemoveInGroupsCount += 1;
        if (isException) exceptionsInGroupsCount += 1;
        if (isDontRemove) continue;

        const checkResult = checkPhoneNumber(phoneNumbersFromDB, member);

        const isAJB = isAJBGroup(groupName);
        const isRJB = isRJBGroup(groupName);
        const isRegularJB = isRegularJBGroup(groupName);
        const isJBGroup = isRegularJB;
        const isNonJB = isNonJBGroup(groupName, jbExceptionGroupNames);

        const isLegalRep = Boolean(checkResult.is_legal_representative);
        const isAdult = Boolean(checkResult.is_adult);
        const childPhoneMatchesRep = Boolean(checkResult.child_phone_matches_legal_rep);
        const isEffectiveLegalRep = isLegalRep || (!isAdult && childPhoneMatchesRep);
        const isChild = !isAdult && !isEffectiveLegalRep;
        const isUnder13 = isChild && Boolean(checkResult.jb_under_13);
        const jb13To17Registration = Boolean(checkResult.jb_13_to_17);
        const isJB13To17 = isChild && jb13To17Registration;
        const hasAcceptedTerms = Boolean(checkResult.has_accepted_terms);

        if (checkResult.found && !isException && isUnder13) {
          pushRemoval({
            type: "remove",
            registration_id: checkResult.mb!,
            groupId,
            phone: member,
            reason: "Under 13 not allowed in WhatsApp groups.",
          });
          totalUnder13Count += 1;
          uniqueUnder13.add(member);
          uniquePhones.add(member);
          continue;
        }

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

        if (checkResult.found && isRJB) {
          if (isChild) {
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
            continue;
          }

          if (!isEffectiveLegalRep) {
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
          }

          if (groupName === "R.JB | Familiares de JB 12+" && !checkResult.represents_jb_13_to_17) {
            pushRemoval({
              type: "remove",
              registration_id: checkResult.mb!,
              groupId,
              phone: member,
              reason: "Member is not legal representative of a 13+ years old member.",
            });
            uniquePhones.add(member);
            continue;
          }

          if (isEffectiveLegalRep && !checkResult.represents_minor) {
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

        if (checkResult.found) {
          if (!isException && !isAJB) {
            if (isJBGroup && isAdult && !isEffectiveLegalRep) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "Adult is not a legal representative in JB group.",
              });
              totalAdultNotLegalRepJBCount += 1;
              uniqueAdultNotLegalRepJB.add(member);
              uniquePhones.add(member);
              continue;
            }

            if (isJBGroup && jb13To17Registration && !hasAcceptedTerms) {
              pushRemoval({
                type: "remove",
                registration_id: checkResult.mb!,
                groupId,
                phone: member,
                reason: "Missing gov.br authorization.",
              });
              totalMissingGovTermsCount += 1;
              uniqueMissingGovTerms.add(member);
              uniquePhones.add(member);
              continue;
            }
          }

          if (!isException && isNonJB && isJB13To17) {
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
            continue;
          }

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
          const shouldRemove = await triggerTwilioOrRemove(member, "mensa_not_found");
          if (shouldRemove) {
            pushRemoval({ type: "remove", registration_id: null, groupId, phone: member, reason: "Not found in DB" });
            totalNotFoundCount += 1;
            uniqueNotFound.add(member);
            uniquePhones.add(member);
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
    totalUnder13Count,
    atleast1Under13Count: uniqueUnder13.size,
    totalMissingGovTermsCount,
    atleast1MissingGovTermsCount: uniqueMissingGovTerms.size,
    totalJBInNonJBCount,
    atleast1JBInNonJBCount: uniqueJBInNonJB.size,
    totalAdultNotLegalRepJBCount,
    atleast1AdultNotLegalRepJBCount: uniqueAdultNotLegalRepJB.size,
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
