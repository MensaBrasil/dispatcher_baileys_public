import { config as configDotenv } from "dotenv";
import {
  getManagedGroupPhoneNumbers,
  getPreviousGroupMembers,
  getUnfulfilledGroupRequestsForScan,
  recordUserEntryToGroup,
  recordUserExitFromGroup,
  registerWhatsappAddFulfilled,
} from "../db/pgsql.js";
import type { PhoneNumberStatusRow } from "../types/PhoneTypes.js";
import type { ScanPolicy } from "../types/PolicyTypes.js";
import { checkGroupType } from "../utils/checkGroupType.js";
import { delaySecs } from "../utils/delay.js";
import {
  extractPhoneFromParticipant,
  type MinimalParticipant as JidParticipant,
  type ResolveLidToPhoneFn,
} from "../utils/jid.js";
import logger from "../utils/logger.js";
import { checkPhoneNumber } from "../utils/phoneCheck.js";
import { REMOVAL_REASONS } from "../utils/whatsappEligibility.js";

configDotenv({ path: ".env" });
const scanDelay = Number.parseInt(process.env.SCAN_DELAY ?? "1", 10) || 0;
const EMPTY_SCAN_POLICY: ScanPolicy = { isInvitedPhone: () => false };

type MinimalGroup = {
  id: string;
  subject?: string;
  name?: string;
  participants: JidParticipant[];
};

export type SendSeenFn = (groupId: string) => Promise<void>;

export async function scanGroups(
  groups: MinimalGroup[],
  phoneNumbersFromDB: Map<string, PhoneNumberStatusRow[]>,
  opts?: { sendSeen?: SendSeenFn; resolveLidToPhone?: ResolveLidToPhoneFn; policy?: ScanPolicy },
): Promise<void> {
  const policy = opts?.policy ?? EMPTY_SCAN_POLICY;
  for (const group of groups) {
    if (scanDelay > 0) {
      await delaySecs(0, scanDelay);
    }
    try {
      const groupName = group.subject ?? group.name ?? group.id;
      logger.info({ group: groupName }, `Escaneando grupo: ${groupName}`);

      const groupId = group.id;
      // Best-effort: send a seen/read signal for the latest message in this group
      try {
        if (opts?.sendSeen) await opts.sendSeen(groupId);
      } catch (err) {
        logger.debug({ err, group: groupName }, "Falha ao enviar sinal de visualização (não fatal)");
      }

      const previousMembers = await getPreviousGroupMembers(groupId);
      logger.debug({ count: previousMembers.length }, "Quantidade de membros anteriores");

      const participants = group.participants;
      const resolvedMembers = await Promise.all(
        participants.map((p) =>
          extractPhoneFromParticipant(p, {
            resolveLidToPhone: opts?.resolveLidToPhone,
          }),
        ),
      );
      const groupMembers = resolvedMembers.filter((x): x is string => Boolean(x));
      logger.debug({ count: groupMembers.length }, "Quantidade de membros atuais");

      const wppQueue = await getUnfulfilledGroupRequestsForScan(groupId);
      const groupType = await checkGroupType(groupName);
      const normalizedGroupMembers = new Set(
        groupMembers
          .map((m) => {
            const digits = String(m || "").replace(/\D/g, "");
            if (!digits) return null;
            return digits.startsWith("55") ? digits.slice(-8) : digits;
          })
          .filter((value): value is string => Boolean(value)),
      );
      if (groupType) {
        for (const request of wppQueue) {
          const requestPhones = await getManagedGroupPhoneNumbers(request.registration_id, groupType);
          for (const phone of requestPhones) {
            const digits = String(phone || "").replace(/\D/g, "");
            if (!digits) continue;
            const lookupKey = digits.startsWith("55") ? digits.slice(-8) : digits;

            if (!normalizedGroupMembers.has(lookupKey)) continue;

            await registerWhatsappAddFulfilled(request.request_id);
            logger.info(
              { request_id: request.request_id, phone, group: groupName, groupType },
              `Solicitação ${request.request_id} do telefone ${phone} foi atendida no grupo ${groupName}.`,
            );
            break;
          }
        }
      }

      for (const previousMember of previousMembers) {
        if (!groupMembers.includes(previousMember)) {
          logger.info({ phone: previousMember, group: groupName }, `Número ${previousMember} não está mais no grupo.`);
          await recordUserExitFromGroup(previousMember, groupId, REMOVAL_REASONS.saiuDoGrupo);
        }
      }

      for (const member of groupMembers) {
        if (policy.isInvitedPhone(member)) {
          continue;
        }
        const checkResult = checkPhoneNumber(phoneNumbersFromDB, member);
        if (!previousMembers.includes(member)) {
          if (checkResult.found) {
            const registrationId = checkResult.mb;
            const status = checkResult.status;
            if (registrationId === undefined || status === undefined) {
              logger.warn(
                { phone: member, group: groupName },
                `Número ${member} é novo no grupo, mas o vínculo no banco está incompleto.`,
              );
              continue;
            }
            logger.info({ phone: member, mb: registrationId, group: groupName }, `Número ${member} é novo no grupo.`);
            await recordUserEntryToGroup(registrationId, member, groupId, status);
          } else {
            logger.warn(
              { phone: member, group: groupName },
              `Número ${member} é novo no grupo, mas não foi encontrado vínculo no banco.`,
            );
          }
        }
      }
    } catch (error) {
      logger.error({ err: error, group: group.name ?? group.subject ?? group.id }, "Erro ao escanear grupo");
    }
  }
}

export default { scanGroups };
