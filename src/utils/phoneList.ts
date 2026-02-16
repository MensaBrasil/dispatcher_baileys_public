function toDigits(value: string): string {
  return value.replace(/\D+/g, "");
}

function getLast8Digits(value: string): string | null {
  if (value.length < 8) return null;
  return value.slice(-8);
}

export function parsePhoneCsv(rawCsv: string | undefined): string[] {
  return (rawCsv ?? "")
    .split(",")
    .map((value) => toDigits(value.trim()))
    .filter(Boolean);
}

export function buildProtectedPhoneMatcher(rawCsv: string | undefined): (phone: string) => boolean {
  const normalizedPhones = parsePhoneCsv(rawCsv);
  const exactPhones = new Set<string>(normalizedPhones);
  const last8Set = new Set<string>(
    normalizedPhones.map(getLast8Digits).filter((value): value is string => value !== null),
  );

  return (phone: string): boolean => {
    const digits = toDigits(phone);
    if (!digits) return false;
    if (exactPhones.has(digits)) return true;

    const last8 = getLast8Digits(digits);
    return last8 !== null && last8Set.has(last8);
  };
}
