import type { PhoneCheckResult, PhoneNumberStatusRow } from "../types/PhoneTypes.js";

export function preprocessPhoneNumbers(
  phoneNumbersFromDB: PhoneNumberStatusRow[],
): Map<string, PhoneNumberStatusRow[]> {
  const phoneNumberMap = new Map<string, PhoneNumberStatusRow[]>();

  for (const entry of phoneNumbersFromDB) {
    let phoneNumber = entry.phone_number;

    if (phoneNumber.includes("+")) {
      phoneNumber = phoneNumber.replace(/\D/g, "");
    } else {
      phoneNumber = `55${phoneNumber.replace(/\D/g, "").replace(/^0+/, "")}`;
    }

    if (phoneNumber.startsWith("55")) {
      const numberWithoutNinthDigit = `${phoneNumber.slice(0, 4)}${phoneNumber.slice(5)}`;
      const numberWithNinthDigit = `${phoneNumber.slice(0, 4)}9${phoneNumber.slice(4)}`;

      const addToMap = (num: string) => {
        const entries = phoneNumberMap.get(num) ?? [];
        entries.push(entry);
        phoneNumberMap.set(num, entries);
      };

      addToMap(phoneNumber);
      addToMap(numberWithoutNinthDigit);
      addToMap(numberWithNinthDigit);
    } else {
      const entries = phoneNumberMap.get(phoneNumber) ?? [];
      entries.push(entry);
      phoneNumberMap.set(phoneNumber, entries);
    }
  }

  return phoneNumberMap;
}

export function checkPhoneNumber(
  phoneNumberMap: Map<string, PhoneNumberStatusRow[]>,
  inputPhoneNumber: string,
): PhoneCheckResult {
  const matchedEntries = phoneNumberMap.get(inputPhoneNumber) ?? [];

  if (matchedEntries.length === 0) {
    return { found: false };
  }

  let hasMemberPhone = false;
  let hasLegalRepPhone = false;
  let hasMemberAdultPhone = false;
  let hasMemberMinorPhone = false;
  let hasLegalRepForMinor = false;
  let hasLegalRepForAdult = false;
  let hasActiveMB = false;
  let hasActiveRJB = false;
  let hasInactiveMB = false;
  let hasInactiveRJB = false;

  for (const entry of matchedEntries) {
    if (entry.phone_role === "member") hasMemberPhone = true;
    if (entry.phone_role === "legal_rep") hasLegalRepPhone = true;
    if (entry.phone_role === "member" && entry.member_age_years >= 18) hasMemberAdultPhone = true;
    if (entry.phone_role === "member" && entry.member_age_years <= 17) hasMemberMinorPhone = true;
    if (entry.phone_role === "legal_rep" && entry.member_age_years <= 17) hasLegalRepForMinor = true;
    if (entry.phone_role === "legal_rep" && entry.member_age_years >= 18) hasLegalRepForAdult = true;

    if (entry.status === "Active" && entry.is_managed_mb_eligible && entry.managed_phone_count === 1) {
      hasActiveMB = true;
    }
    if (
      entry.status === "Active" &&
      entry.is_managed_rjb_eligible &&
      entry.managed_phone_count >= 1 &&
      entry.managed_phone_count <= 2
    ) {
      hasActiveRJB = true;
    }
    if (entry.status === "Inactive" && entry.phone_role === "member" && entry.member_age_years >= 18)
      hasInactiveMB = true;
    if (entry.status === "Inactive" && entry.phone_role === "legal_rep" && entry.member_age_years <= 17) {
      hasInactiveRJB = true;
    }
  }

  const primary = matchedEntries[0];
  if (!primary) {
    return { found: false };
  }
  const status: "Active" | "Inactive" = hasActiveMB || hasActiveRJB ? "Active" : "Inactive";

  return {
    found: true,
    status,
    mb: primary.registration_id,
    has_member_phone: hasMemberPhone,
    has_legal_rep_phone: hasLegalRepPhone,
    has_member_adult_phone: hasMemberAdultPhone,
    has_member_minor_phone: hasMemberMinorPhone,
    has_legal_rep_for_minor: hasLegalRepForMinor,
    has_legal_rep_for_adult: hasLegalRepForAdult,
    is_legal_representative: hasLegalRepPhone,
    has_active_mb: hasActiveMB,
    has_active_rjb: hasActiveRJB,
    has_inactive_mb: hasInactiveMB,
    has_inactive_rjb: hasInactiveRJB,
  };
}
