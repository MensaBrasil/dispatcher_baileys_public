import type { GroupType } from "../types/DBTypes.js";
import type { PhoneCheckResult } from "../types/PhoneTypes.js";

export type RegistrationEligibility = {
  registrationId: number;
  isActive: boolean;
  isAdult: boolean;
  isMinor: boolean;
  hasMemberPhone: boolean;
  hasLegalRepPhone: boolean;
  memberPhoneCount: number;
  legalRepPhoneCount: number;
};

export type GroupEligibilityResult = {
  shouldAdd: boolean;
  shouldRemove: boolean;
  removalReason: string | null;
  waitForGracePeriod: boolean;
};

export const COMMUNICATION_REASONS = {
  membroInativo: "Membro Inativo",
  membroNaoEncontradoNoBanco: "Membro não encontrado no banco",
} as const;

export type CommunicationReason = (typeof COMMUNICATION_REASONS)[keyof typeof COMMUNICATION_REASONS];

export const REMOVAL_REASONS = {
  telefoneNaoEncontrado: "Telefone não encontrado no banco.",
  membroInativoMb: "Membro inativo para elegibilidade em grupo MB.",
  menorEmGrupoMb: "Membro menor de 18 anos não pode permanecer em grupos MB.",
  apenasResponsavelMb:
    "Telefone cadastrado apenas como responsável legal, não como telefone de membro elegível para MB.",
  semTelefoneMembroMb: "Telefone não cadastrado na lista de telefones de membro exigida para grupos MB.",
  inelegivelMb: "Telefone não atende aos critérios de elegibilidade para MB.",
  membroInativoRjb: "Menor vinculado inativo para elegibilidade em grupo RJB.",
  responsavelSemMenorRjb: "Responsável legal não está mais vinculado a menor de 17 anos ou menos para grupos RJB.",
  apenasMembroRjb:
    "Telefone cadastrado apenas como telefone de membro, não como telefone de responsável legal exigido para RJB.",
  semTelefoneResponsavelRjb:
    "Telefone não cadastrado na lista de telefones de responsável legal exigida para grupos RJB.",
  inelegivelRjb: "Telefone não atende aos critérios de elegibilidade para RJB.",
  inelegivelGrupoGerenciado: "Telefone não elegível para grupo gerenciado.",
  suspensoWhatsapp: "Telefone suspenso pela política de WhatsApp (`whatsapp_suspended_numbers`).",
  saiuDoGrupo: "Saiu do grupo.",
} as const;

export function isEligibleRegistrationForGroup(
  registration: RegistrationEligibility | undefined,
  groupType: GroupType | null,
): boolean {
  if (!registration || !groupType) return false;
  if (!registration.isActive) return false;

  if (groupType === "MB") {
    return registration.isAdult && registration.hasMemberPhone && registration.memberPhoneCount === 1;
  }

  if (groupType === "RJB") {
    return (
      registration.isMinor &&
      registration.hasLegalRepPhone &&
      registration.legalRepPhoneCount >= 1 &&
      registration.legalRepPhoneCount <= 2
    );
  }

  return false;
}

export function evaluatePhoneForGroup(checkResult: PhoneCheckResult, groupType: GroupType): GroupEligibilityResult {
  if (!checkResult.found) {
    return {
      shouldAdd: false,
      shouldRemove: true,
      removalReason: REMOVAL_REASONS.telefoneNaoEncontrado,
      waitForGracePeriod: true,
    };
  }

  if (groupType === "MB") {
    if (checkResult.has_active_mb) {
      return {
        shouldAdd: true,
        shouldRemove: false,
        removalReason: null,
        waitForGracePeriod: false,
      };
    }

    return {
      shouldAdd: false,
      shouldRemove: true,
      removalReason: checkResult.has_inactive_mb
        ? REMOVAL_REASONS.membroInativoMb
        : checkResult.has_member_minor_phone
          ? REMOVAL_REASONS.menorEmGrupoMb
          : checkResult.has_legal_rep_phone && !checkResult.has_member_phone
            ? REMOVAL_REASONS.apenasResponsavelMb
            : !checkResult.has_member_phone
              ? REMOVAL_REASONS.semTelefoneMembroMb
              : REMOVAL_REASONS.inelegivelMb,
      waitForGracePeriod: Boolean(checkResult.has_inactive_mb),
    };
  }

  if (groupType === "RJB") {
    if (checkResult.has_active_rjb) {
      return {
        shouldAdd: true,
        shouldRemove: false,
        removalReason: null,
        waitForGracePeriod: false,
      };
    }

    return {
      shouldAdd: false,
      shouldRemove: true,
      removalReason: checkResult.has_inactive_rjb
        ? REMOVAL_REASONS.membroInativoRjb
        : checkResult.has_legal_rep_for_adult
          ? REMOVAL_REASONS.responsavelSemMenorRjb
          : checkResult.has_member_phone && !checkResult.has_legal_rep_phone
            ? REMOVAL_REASONS.apenasMembroRjb
            : !checkResult.has_legal_rep_phone
              ? REMOVAL_REASONS.semTelefoneResponsavelRjb
              : REMOVAL_REASONS.inelegivelRjb,
      waitForGracePeriod: Boolean(checkResult.has_inactive_rjb),
    };
  }

  return {
    shouldAdd: false,
    shouldRemove: false,
    removalReason: null,
    waitForGracePeriod: false,
  };
}
