import type { WhatsAppWorker } from "../types/DBTypes.js";

type PhoneMatchMetadata = {
  canonicalKey: string;
  directVariants: Set<string>;
  last8Variants: Set<string>;
  allowsLegacyLast8: boolean;
};

type AuthorizationCandidate = {
  canonicalKey: string;
  workerPhone: string;
  allowsLegacyLast8: boolean;
};

export type AuthorizationLookup = {
  orderedWorkerPhones: string[];
  authorizationByDirect: Map<string, Set<string>>;
  authorizationCandidatesByLast8: Map<string, AuthorizationCandidate[]>;
};

type SuspendedCandidate = {
  canonicalKey: string;
  allowsLegacyLast8: boolean;
};

export type SuspendedPhoneLookup = {
  suspendedDirectVariants: Set<string>;
  suspendedCandidatesByLast8: Map<string, SuspendedCandidate[]>;
};

function normalizePhoneDigits(phoneNumber: string | null | undefined): string {
  return String(phoneNumber ?? "")
    .split("")
    .filter((character) => character >= "0" && character <= "9")
    .join("")
    .replace(/^0+/, "");
}

function normalizePhoneCanonicalKey(phoneNumber: string | null | undefined): string {
  const digitsOnly = normalizePhoneDigits(phoneNumber);
  if (!digitsOnly) return "";

  let nationalNumber = digitsOnly;
  if (nationalNumber.startsWith("55") && nationalNumber.length > 11) {
    nationalNumber = nationalNumber.slice(2);
  }

  if (nationalNumber.length === 10) {
    return `${nationalNumber.slice(0, 2)}9${nationalNumber.slice(2)}`;
  }

  return nationalNumber;
}

function extractPhoneMatchMetadata(phoneNumber: string | null | undefined): PhoneMatchMetadata {
  const digitsOnly = normalizePhoneDigits(phoneNumber);
  if (!digitsOnly) {
    return {
      canonicalKey: "",
      directVariants: new Set<string>(),
      last8Variants: new Set<string>(),
      allowsLegacyLast8: false,
    };
  }

  let nationalNumber = digitsOnly;
  if (nationalNumber.startsWith("55") && nationalNumber.length > 11) {
    nationalNumber = nationalNumber.slice(2);
  }

  const directVariants = new Set<string>();
  const stack = [digitsOnly];

  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || directVariants.has(candidate)) {
      continue;
    }

    directVariants.add(candidate);

    if (candidate.startsWith("55") && candidate.length > 11) {
      stack.push(candidate.slice(2));
    }

    if (candidate.length === 10 || candidate.length === 11) {
      stack.push(`55${candidate}`);
    }

    if (candidate.length === 10) {
      stack.push(`${candidate.slice(0, 2)}9${candidate.slice(2)}`);
    }

    if (candidate.length === 11 && candidate[2] === "9") {
      stack.push(`${candidate.slice(0, 2)}${candidate.slice(3)}`);
    }
  }

  const last8Variants = new Set<string>();
  for (const variant of directVariants) {
    if (variant.length >= 8) {
      last8Variants.add(variant.slice(-8));
    }
  }

  return {
    canonicalKey: normalizePhoneCanonicalKey(phoneNumber),
    directVariants,
    last8Variants,
    allowsLegacyLast8: nationalNumber.length > 0 && nationalNumber.length < 10,
  };
}

function pushMapSetEntry(map: Map<string, Set<string>>, key: string, value: string): void {
  const current = map.get(key) ?? new Set<string>();
  current.add(value);
  map.set(key, current);
}

function pushMapArrayEntry<T>(map: Map<string, T[]>, key: string, value: T): void {
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

export function buildAuthorizationLookup(
  workers: WhatsAppWorker[],
  authorizations: Array<{ phone_number: string | null; worker_id: number | null }>,
): AuthorizationLookup {
  const orderedWorkerPhones = [...workers]
    .sort((left, right) => left.id - right.id)
    .map((worker) => worker.worker_phone)
    .filter(Boolean);

  const workerIdToPhone = new Map<number, string>();
  for (const worker of workers) {
    if (worker.id != null && worker.worker_phone) {
      workerIdToPhone.set(worker.id, worker.worker_phone);
    }
  }

  const authorizationByDirect = new Map<string, Set<string>>();
  const authorizationCandidatesByLast8 = new Map<string, AuthorizationCandidate[]>();

  for (const authorization of authorizations) {
    const workerPhone = authorization.worker_id == null ? undefined : workerIdToPhone.get(authorization.worker_id);
    if (!workerPhone || !authorization.phone_number) {
      continue;
    }

    const metadata = extractPhoneMatchMetadata(authorization.phone_number);
    for (const variant of metadata.directVariants) {
      pushMapSetEntry(authorizationByDirect, variant, workerPhone);
    }

    const candidate = {
      canonicalKey: metadata.canonicalKey,
      workerPhone,
      allowsLegacyLast8: metadata.allowsLegacyLast8,
    };
    for (const variant of metadata.last8Variants) {
      pushMapArrayEntry(authorizationCandidatesByLast8, variant, candidate);
    }
  }

  return {
    orderedWorkerPhones,
    authorizationByDirect,
    authorizationCandidatesByLast8,
  };
}

export function resolveAuthorizedWorkersForPhone(
  phoneNumber: string | null | undefined,
  lookup: AuthorizationLookup,
): string[] {
  const metadata = extractPhoneMatchMetadata(phoneNumber);
  const authorizedWorkers = new Set<string>();

  for (const variant of metadata.directVariants) {
    const workers = lookup.authorizationByDirect.get(variant);
    if (!workers) continue;
    for (const worker of workers) {
      authorizedWorkers.add(worker);
    }
  }

  if (authorizedWorkers.size === 0) {
    const fallbackWorkers = new Set<string>();
    const fallbackCanonicalKeys = new Set<string>();

    for (const variant of metadata.last8Variants) {
      const candidates = lookup.authorizationCandidatesByLast8.get(variant) ?? [];
      for (const candidate of candidates) {
        if (!metadata.allowsLegacyLast8 && !candidate.allowsLegacyLast8) {
          continue;
        }

        fallbackWorkers.add(candidate.workerPhone);
        fallbackCanonicalKeys.add(candidate.canonicalKey);
      }
    }

    if (fallbackCanonicalKeys.size === 1) {
      for (const worker of fallbackWorkers) {
        authorizedWorkers.add(worker);
      }
    }
  }

  return lookup.orderedWorkerPhones.filter((worker) => authorizedWorkers.has(worker));
}

export function buildSuspendedPhoneLookup(phoneNumbers: Iterable<string>): SuspendedPhoneLookup {
  const suspendedDirectVariants = new Set<string>();
  const suspendedCandidatesByLast8 = new Map<string, SuspendedCandidate[]>();

  for (const phoneNumber of phoneNumbers) {
    const metadata = extractPhoneMatchMetadata(phoneNumber);
    for (const variant of metadata.directVariants) {
      suspendedDirectVariants.add(variant);
    }

    const candidate = {
      canonicalKey: metadata.canonicalKey,
      allowsLegacyLast8: metadata.allowsLegacyLast8,
    };
    for (const variant of metadata.last8Variants) {
      pushMapArrayEntry(suspendedCandidatesByLast8, variant, candidate);
    }
  }

  return {
    suspendedDirectVariants,
    suspendedCandidatesByLast8,
  };
}

export function isPhoneInSuspendedLookup(
  phoneNumber: string | null | undefined,
  lookup: SuspendedPhoneLookup,
): boolean {
  const metadata = extractPhoneMatchMetadata(phoneNumber);
  if (!metadata.canonicalKey) {
    return false;
  }

  for (const variant of metadata.directVariants) {
    if (lookup.suspendedDirectVariants.has(variant)) {
      return true;
    }
  }

  const fallbackCanonicalKeys = new Set<string>();
  for (const variant of metadata.last8Variants) {
    const candidates = lookup.suspendedCandidatesByLast8.get(variant) ?? [];
    for (const candidate of candidates) {
      if (!metadata.allowsLegacyLast8 && !candidate.allowsLegacyLast8) {
        continue;
      }

      fallbackCanonicalKeys.add(candidate.canonicalKey);
    }
  }

  return fallbackCanonicalKeys.size === 1;
}
