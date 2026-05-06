import type { GroupType } from "../types/DBTypes.js";

function normalizeGroupName(name: string | undefined | null): string {
  return String(name ?? "").trim();
}

const explicitMBGroupNames = new Set([
  "Mensampa Regional",
  "Mensa Ribeirão Preto, São Carlos, Araraquara e redondezas",
  "Mensa São José dos Campos e região",
]);

const explicitRJBGroupNames = new Set([
  "Avisos Mensa JB C.O/N",
  "Avisos Mensa JB Nordeste",
  "Avisos Mensa JB SP CIDADE",
  "Avisos Mensa JB SP ESTADO",
  "Avisos Mensa JB SUDESTE",
]);

export function isMBWomenGroup(name: string | undefined | null): boolean {
  return normalizeGroupName(name) === "MB | Mulheres";
}

export function isMBGroup(name: string | undefined | null): boolean {
  const normalized = normalizeGroupName(name);
  return (
    explicitMBGroupNames.has(normalized) ||
    /^Mensa\s+\S.*\s+Regional$/i.test(normalized) ||
    /^Avisos Mensa\b/i.test(normalized) ||
    /^MB\s*\|\s*\S/i.test(normalized)
  );
}

export function isRJBGroup(name: string | undefined | null): boolean {
  const normalized = normalizeGroupName(name);
  return explicitRJBGroupNames.has(normalized) || /^R\.\s?JB\s*\|\s*\S/i.test(normalized);
}

export function isOrgMBGroup(name: string | undefined | null): boolean {
  return /^OrgMB\s*\|\s*\S/i.test(normalizeGroupName(name));
}

export function isManagedGroup(name: string | undefined | null): boolean {
  return isMBGroup(name) || isRJBGroup(name) || isOrgMBGroup(name);
}

export async function checkGroupType(groupName: string | undefined | null): Promise<GroupType | null> {
  try {
    if (isOrgMBGroup(groupName)) return "OrgMB";
    if (isRJBGroup(groupName)) return "RJB";
    if (isMBGroup(groupName)) return "MB";
  } catch {
    return null;
  }
  return null;
}

export default { checkGroupType };
