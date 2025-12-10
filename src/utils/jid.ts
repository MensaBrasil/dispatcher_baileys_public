export type MinimalParticipant =
  | { id?: { user?: string }; phoneNumber?: string; lid?: string }
  | { user?: string }
  | { id: string; phoneNumber?: string; jid?: string; lid?: string }
  | string;

export type ResolveLidToPhoneFn = (lid: string) => string | null | undefined | Promise<string | null | undefined>;

type ExtractOptions = {
  /**
   * Optional explicit PN (e.g., participantAlt or remoteJidAlt from Baileys message keys).
   */
  altJid?: string | null;
  /**
   * Callback to resolve LID -> PN using Baileys' signalRepository.lidMapping store.
   */
  resolveLidToPhone?: ResolveLidToPhoneFn;
};

function onlyDigits(s: string | undefined | null): string | null {
  if (!s) return null;
  const digits = s.replace(/\D+/g, "");
  return digits.length >= 7 ? digits : null; // basic sanity
}

function extractPhoneFromPnJid(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const [user, domain] = jid.split("@", 2);
  if (!user || !domain) return null;
  if (domain !== "s.whatsapp.net" && domain !== "c.us") return null;
  return onlyDigits(user);
}

function extractLidFromJid(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const [, domain] = jid.split("@", 2);
  if (!domain) return null;
  return domain === "lid" ? jid : null;
}

function normalizeParticipantId(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && "user" in (val as { user?: unknown })) {
    const user = String((val as { user?: unknown }).user ?? "");
    const digits = onlyDigits(user);
    if (digits) {
      return `${digits}@s.whatsapp.net`;
    }
  }
  return null;
}

export async function resolveParticipantIdentity(
  p: MinimalParticipant,
  opts: ExtractOptions = {},
): Promise<{ phone: string | null; lid: string | null }> {
  // 1) Prefer explicit alt JID (participantAlt/remoteJidAlt) because Baileys supplies PN here when participant is LID
  const altPhone = extractPhoneFromPnJid(opts.altJid);
  if (altPhone) {
    return {
      phone: altPhone,
      lid: extractLidFromJid(typeof p === "string" ? p : ((p as { lid?: string }).lid ?? null)),
    };
  }

  // 2) Direct phoneNumber field on participant (new Contact shape)
  if (p && typeof p === "object" && "phoneNumber" in p) {
    const phone = onlyDigits((p as { phoneNumber?: string }).phoneNumber ?? null);
    if (phone) {
      const lid = extractLidFromJid((p as { lid?: string }).lid ?? null);
      return { phone, lid };
    }
  }

  // 3) Attempt PN JIDs from id/jid
  if (p && typeof p === "object") {
    const val = (p as { id?: unknown }).id ?? (p as { jid?: unknown }).jid;
    const normalized = normalizeParticipantId(val);
    const pn = extractPhoneFromPnJid(normalized);
    if (pn) {
      return { phone: pn, lid: extractLidFromJid(typeof val === "string" ? val : null) };
    }
  } else if (typeof p === "string") {
    const pn = extractPhoneFromPnJid(p);
    if (pn) {
      return { phone: pn, lid: extractLidFromJid(p) };
    }
  }

  // 4) Last resort: if we have a LID and a resolver, use it
  let lid: string | null = null;
  if (p && typeof p === "object") {
    const val = (p as { id?: unknown }).id ?? (p as { lid?: unknown }).lid;
    if (typeof val === "string") {
      lid = extractLidFromJid(val) ?? null;
    }
  } else if (typeof p === "string") {
    lid = extractLidFromJid(p);
  }

  if (lid && opts.resolveLidToPhone) {
    const resolved = await opts.resolveLidToPhone(lid);
    if (resolved) {
      return { phone: resolved, lid };
    }
  }

  return { phone: null, lid };
}

export async function extractPhoneFromParticipant(
  p: MinimalParticipant,
  opts?: ExtractOptions,
): Promise<string | null> {
  const { phone } = await resolveParticipantIdentity(p, opts);
  return phone;
}

export default { extractPhoneFromParticipant, resolveParticipantIdentity };
