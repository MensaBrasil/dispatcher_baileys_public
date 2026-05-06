import type { GroupType } from "../types/DBTypes.js";
import type { WhatsAppInvitedPolicyEntry } from "../types/PolicyTypes.js";

function toDigits(value: string): string {
  return value.replace(/\D+/g, "");
}

function normalizeForWhatsappLookup(phone: string): string | null {
  const digits = toDigits(phone);
  if (!digits) return null;
  return digits.startsWith("55") ? digits.slice(-8) : digits;
}

export function expandBrazilianPhoneVariants(phone: string): string[] {
  const digits = toDigits(phone);
  const variants = new Set<string>([digits]);

  if (!digits.startsWith("55")) {
    return [...variants];
  }

  const dddPrefix = digits.slice(0, 4);
  const localNumber = digits.slice(4);

  if (localNumber.length === 8) {
    variants.add(`${dddPrefix}9${localNumber}`);
  } else if (localNumber.length === 9 && localNumber.startsWith("9")) {
    variants.add(`${dddPrefix}${localNumber.slice(1)}`);
  }

  return [...variants];
}

export function parsePhoneCsv(rawCsv: string | undefined): string[] {
  return (rawCsv ?? "")
    .split(",")
    .map((value) => toDigits(value.trim()))
    .filter(Boolean);
}

export function buildProtectedPhoneMatcherFromList(phoneNumbers: Iterable<string>): (phone: string) => boolean {
  const normalizedPhones = [...phoneNumbers].map((value) => toDigits(String(value).trim())).filter(Boolean);
  const allowedPhones = new Set<string>(
    normalizedPhones
      .map((value) => normalizeForWhatsappLookup(value))
      .filter((value): value is string => value !== null),
  );

  return (phone: string): boolean => {
    const lookupKey = normalizeForWhatsappLookup(phone);
    return lookupKey !== null && allowedPhones.has(lookupKey);
  };
}

function normalizeInvitedGroupType(groupType: WhatsAppInvitedPolicyEntry["group_type"]): GroupType | null {
  if (groupType === "MB") return "MB";
  if (groupType === "R. JB") return "RJB";
  return null;
}

export function buildInvitedPhoneMatcher(
  invitedNumbers: Iterable<WhatsAppInvitedPolicyEntry>,
): (phone: string, groupType?: GroupType | null) => boolean {
  const allowedGroupTypesByPhone = new Map<string, Set<GroupType | "*">>();

  for (const entry of invitedNumbers) {
    const lookupKey = normalizeForWhatsappLookup(toDigits(String(entry.phone_number ?? "").trim()));
    if (!lookupKey) continue;

    const groupType = normalizeInvitedGroupType(entry.group_type) ?? "*";
    const allowedGroupTypes = allowedGroupTypesByPhone.get(lookupKey) ?? new Set<GroupType | "*">();
    allowedGroupTypes.add(groupType);
    allowedGroupTypesByPhone.set(lookupKey, allowedGroupTypes);
  }

  return (phone: string, groupType?: GroupType | null): boolean => {
    const lookupKey = normalizeForWhatsappLookup(phone);
    if (!lookupKey) return false;

    const allowedGroupTypes = allowedGroupTypesByPhone.get(lookupKey);
    if (!allowedGroupTypes) return false;
    if (allowedGroupTypes.has("*")) return true;
    if (groupType == null) return allowedGroupTypes.size > 0;

    return allowedGroupTypes.has(groupType);
  };
}

export function buildSuspendedPhoneMatcherFromList(phoneNumbers: Iterable<string>): (phone: string) => boolean {
  const normalizedPhones = [...phoneNumbers].map((value) => toDigits(String(value).trim())).filter(Boolean);
  const allowedPhones = new Set<string>(
    normalizedPhones
      .map((value) => normalizeForWhatsappLookup(value))
      .filter((value): value is string => value !== null),
  );

  return (phone: string): boolean => {
    const lookupKey = normalizeForWhatsappLookup(phone);
    return lookupKey !== null && allowedPhones.has(lookupKey);
  };
}

export function buildProtectedPhoneMatcher(rawCsv: string | undefined): (phone: string) => boolean {
  return buildProtectedPhoneMatcherFromList(parsePhoneCsv(rawCsv));
}
