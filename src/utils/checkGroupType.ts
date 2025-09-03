import type { GroupType } from "../types/DBTypes.js";

function isMBTokenGroup(name: string): boolean {
  const n = name.trim().toUpperCase();
  return /(\b|\[|\()MB(\b|\]|\))/.test(n);
}

export async function checkGroupType(groupName: string): Promise<GroupType | null> {
  try {
    if (isRegularJBGroup(groupName)) return "JB";
    if (isMJBGroup(groupName)) return "MJB";
    if (isRJBGroup(groupName)) return "RJB";
    if (isMBTokenGroup(groupName)) return "MB";
    if (isAJBGroup(groupName)) return "AJB";
  } catch {
    // Swallow and return null per legacy behavior
    return null;
  }
  return null;
}

export default { checkGroupType };

// Extra helpers for removeTask
export function isRegularJBGroup(name: string): boolean {
  return /JB/i.test(name) && !/M\.?\s?JB/i.test(name) && !/R\.?\s?JB/i.test(name);
}

export function isMJBGroup(name: string): boolean {
  return /M\.?\s?JB/i.test(name) && !/R\.?\s?JB/i.test(name);
}

export function isRJBGroup(name: string): boolean {
  return /R\.?\s?JB/i.test(name);
}

export function isAJBGroup(name: string): boolean {
  return /A\.?\s?JB/i.test(name);
}

export function isNonJBGroup(name: string, jbExceptionGroupNames: string[]): boolean {
  return !/JB/i.test(name) && !jbExceptionGroupNames.includes(name);
}

export function isMBMulheresGroup(name: string): boolean {
  return /^MB\s*\|\s*Mulheres$/i.test(name.trim());
}
