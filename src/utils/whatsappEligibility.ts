import type { GroupType } from "../types/DBTypes.js";
import type { PhoneCheckResult } from "../types/PhoneTypes.js";

export type RegistrationEligibility = {
  registrationId: number;
  isActive: boolean;
  isAdult: boolean;
  isMinor: boolean;
  hasMemberPhone: boolean;
  hasLegalRepPhone: boolean;
};

export type GroupEligibilityResult = {
  shouldAdd: boolean;
  shouldRemove: boolean;
  removalReason: string | null;
  waitForGracePeriod: boolean;
};

export function isEligibleRegistrationForGroup(
  registration: RegistrationEligibility | undefined,
  groupType: GroupType | null,
): boolean {
  if (!registration || !groupType) return false;
  if (!registration.isActive) return false;

  if (groupType === "MB") {
    return registration.isAdult && registration.hasMemberPhone;
  }

  if (groupType === "RJB") {
    return registration.isMinor && registration.hasLegalRepPhone;
  }

  return false;
}

export function evaluatePhoneForGroup(checkResult: PhoneCheckResult, groupType: GroupType): GroupEligibilityResult {
  if (!checkResult.found) {
    return {
      shouldAdd: false,
      shouldRemove: true,
      removalReason: "Phone number is not associated with any registration in the database.",
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
        ? "Inactive member account for MB eligibility."
        : checkResult.has_member_minor_phone
          ? "Member is under 18 and cannot remain in MB groups."
          : checkResult.has_legal_rep_phone && !checkResult.has_member_phone
            ? "Phone is registered only as a legal representative, not as a member phone eligible for MB."
            : !checkResult.has_member_phone
              ? "Phone is not registered in the member phone list required for MB groups."
              : "Phone does not meet the MB eligibility criteria.",
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
        ? "Inactive linked minor account for RJB eligibility."
        : checkResult.has_legal_rep_for_adult
          ? "Legal representative no longer linked to a minor aged 17 or younger for RJB groups."
          : checkResult.has_member_phone && !checkResult.has_legal_rep_phone
            ? "Phone is registered only as a member phone, not as a legal representative phone required for RJB groups."
            : !checkResult.has_legal_rep_phone
              ? "Phone is not registered in the legal representative phone list required for RJB groups."
              : "Phone does not meet the RJB eligibility criteria.",
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
