import { config as configDotenv } from "dotenv";
import logger from "../utils/logger.js";
import {
  getPreviousGroupMembers,
  recordUserExitFromGroup,
  recordUserEntryToGroup,
  getWhatsappQueue,
  getMemberPhoneNumbers,
  registerWhatsappAddFulfilled,
} from "../db/pgsql.js";
import { delaySecs } from "../utils/delay.js";
import { checkPhoneNumber } from "../utils/phoneCheck.js";
import { extractPhoneFromParticipant, type MinimalParticipant as JidParticipant } from "../utils/jid.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";

configDotenv({ path: ".env" });

const ignoreNumbers = (process.env.DONT_REMOVE_NUMBERS ?? "").split(",").filter(Boolean);
const scanDelay = Number.parseInt(process.env.SCAN_DELAY ?? "1", 10) || 0;

type MinimalGroup = {
  id: string;
  subject?: string;
  name?: string;
  participants: JidParticipant[];
};

export async function scanGroups(
  groups: MinimalGroup[],
  phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>,
): Promise<void> {
  for (const group of groups) {
    if (scanDelay > 0) {
      await delaySecs(0, scanDelay);
    }
    try {
      const groupName = group.subject ?? group.name ?? group.id;
      logger.info({ group: groupName }, `Scanning group: ${groupName}`);

      const groupId = group.id;
      const previousMembers = await getPreviousGroupMembers(groupId);
      logger.debug({ count: previousMembers.length }, "Previous members count");

      const participants = group.participants;
      const groupMembers = participants.map(extractPhoneFromParticipant).filter((x): x is string => Boolean(x));
      logger.debug({ count: groupMembers.length }, "Current members count");

      const wppQueue = await getWhatsappQueue(groupId);

      const last8digitsGroupMembers = new Set(groupMembers.map((m) => m.slice(-8)));
      for (const request of wppQueue) {
        const requestPhones = await getMemberPhoneNumbers(request.registration_id);
        for (const phone of requestPhones) {
          const last8 = phone.slice(-8);
          if (last8digitsGroupMembers.has(last8)) {
            await registerWhatsappAddFulfilled(request.request_id);
            logger.info(
              { request_id: request.request_id, phone, group: groupName },
              `Request ${request.request_id} for phone ${phone} is fulfilled in group ${groupName}.`,
            );
          }
        }
      }

      for (const previousMember of previousMembers) {
        if (!groupMembers.includes(previousMember)) {
          logger.info(
            { phone: previousMember, group: groupName },
            `Number ${previousMember} is no longer in the group.`,
          );
          await recordUserExitFromGroup(previousMember, groupId, "Left group");
        }
      }

      for (const member of groupMembers) {
        if (ignoreNumbers.includes(member)) {
          continue;
        }
        const checkResult = checkPhoneNumber(phoneNumbersFromDB, member);
        if (!previousMembers.includes(member)) {
          if (checkResult.found) {
            logger.info(
              { phone: member, mb: checkResult.mb, group: groupName },
              `Number ${member} is new to the group.`,
            );
            await recordUserEntryToGroup(checkResult.mb!, member, groupId, checkResult.status!);
          } else {
            logger.warn(
              { phone: member, group: groupName },
              `Number ${member} is new to the group, but no DB match found.`,
            );
          }
        }
      }
    } catch (error) {
      logger.error({ err: error, group: group.name ?? group.subject ?? group.id }, `Error scanning group`);
      continue; // proceed to next group
    }
  }
}

export default { scanGroups };
