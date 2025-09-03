export type MinimalParticipant = { id?: { user?: string } } | { user?: string } | { id: string } | string;

function onlyDigits(s: string | undefined | null): string | null {
  if (!s) return null;
  const digits = s.replace(/\D+/g, "");
  return digits.length >= 7 ? digits : null; // basic sanity
}

function extractFromJid(jid: string): string | null {
  // Accept real user JIDs only (avoid LIDs or non-user domains)
  const [user, domain] = jid.split("@", 2);
  if (!user || !domain) return null;
  if (domain !== "s.whatsapp.net" && domain !== "c.us") return null;
  return onlyDigits(user);
}

export function extractPhoneFromParticipant(p: MinimalParticipant): string | null {
  if (typeof p === "string") {
    return extractFromJid(p);
  }
  if (p && typeof p === "object") {
    if ("id" in p) {
      const val = (p as { id?: unknown }).id;
      if (typeof val === "string") {
        return extractFromJid(val);
      }
      if (val && typeof val === "object" && "user" in (val as { user?: unknown })) {
        return onlyDigits(String((val as { user?: unknown }).user ?? ""));
      }
    }
    if ("user" in p) {
      return onlyDigits(String((p as { user?: unknown }).user ?? ""));
    }
  }
  return null;
}

export default { extractPhoneFromParticipant };
