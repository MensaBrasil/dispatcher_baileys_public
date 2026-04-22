export type ActiveWhatsappPolicy = {
  invitedPhones: string[];
  suspendedPhones: string[];
  suspendedRegistrationIds: number[];
};

export type AddPolicy = {
  suspendedRegistrationIds: Set<number>;
  suspendedPhones: string[];
};

export type RemovalPolicy = {
  isInvitedPhone: (phone: string) => boolean;
  isSuspendedPhone: (phone: string) => boolean;
};

export type ScanPolicy = {
  isInvitedPhone: (phone: string) => boolean;
};
