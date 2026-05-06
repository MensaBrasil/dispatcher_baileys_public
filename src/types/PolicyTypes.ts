import type { GroupType } from "./DBTypes.js";

export type WhatsAppInvitedGroupType = "MB" | "R. JB" | "TODOS" | "OrgMB";

export type WhatsAppInvitedPolicyEntry = {
  phone_number: string;
  group_type: WhatsAppInvitedGroupType | null;
};

export type ActiveWhatsappPolicy = {
  invitedNumbers: WhatsAppInvitedPolicyEntry[];
  suspendedPhones: string[];
  suspendedRegistrationIds: number[];
};

export type AddPolicy = {
  suspendedRegistrationIds: Set<number>;
  suspendedPhones: string[];
  isInvitedPhone: (phone: string, groupType: GroupType | null) => boolean;
};

export type RemovalPolicy = {
  isInvitedPhone: (phone: string, groupType: GroupType | null) => boolean;
  isSuspendedPhone: (phone: string) => boolean;
};

export type ScanPolicy = {
  isInvitedPhone: (phone: string, groupType: GroupType | null) => boolean;
};
