import type { GroupType } from "../types/DBTypes.js";

function normalizeGroupName(name: string | undefined | null): string {
  return String(name ?? "").trim();
}

export function isMBGroup(name: string | undefined | null): boolean {
  const normalized = normalizeGroupName(name);
  return (
    /^Mensa\b.*\bRegional\b/i.test(normalized) || /^Avisos Mensa\b/i.test(normalized) || /^MB\s*\|/i.test(normalized)
  );
}

export function isRJBGroup(name: string | undefined | null): boolean {
  const normalized = normalizeGroupName(name);
  return /^R\.\s?JB\s*\|/i.test(normalized);
}

export function isManagedGroup(name: string | undefined | null): boolean {
  return isMBGroup(name) || isRJBGroup(name);
}

export async function checkGroupType(groupName: string | undefined | null): Promise<GroupType | null> {
  try {
    if (isRJBGroup(groupName)) return "RJB";
    if (isMBGroup(groupName)) return "MB";
  } catch {
    return null;
  }
  return null;
}

export default { checkGroupType };
