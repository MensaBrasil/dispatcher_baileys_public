function toDigits(value: string): string {
  return value.replace(/\D+/g, "");
}

function getLast8Digits(value: string): string | null {
  if (value.length < 8) return null;
  return value.slice(-8);
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

export function buildSuspendedPhoneMatcherFromList(phoneNumbers: Iterable<string>): (phone: string) => boolean {
  const normalizedPhones = [...phoneNumbers].map((value) => toDigits(String(value).trim())).filter(Boolean);
  const allowedPhones = new Set<string>(normalizedPhones.flatMap((value) => expandBrazilianPhoneVariants(value)));

  return (phone: string): boolean => {
    const digits = toDigits(phone);
    if (!digits) return false;
    return allowedPhones.has(digits);
  };
}

export function buildProtectedPhoneMatcher(rawCsv: string | undefined): (phone: string) => boolean {
  return buildProtectedPhoneMatcherFromList(parsePhoneCsv(rawCsv));
}
