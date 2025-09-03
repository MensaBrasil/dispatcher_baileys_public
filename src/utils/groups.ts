import type { WASocket, GroupMetadata } from "baileys";

type BaileysParticipant = { id: string; admin?: "admin" | "superadmin" | null; jid?: string } | { id: string } | string;

export type MinimalGroup = {
  id: string;
  subject?: string;
  name?: string;
  participants: BaileysParticipant[];
  announceGroup?: string | null;
  addressingMode?: "pn" | "lid" | string | null;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
};

function hasJid(x: unknown): x is { jid?: string } {
  return typeof x === "object" && x !== null && "jid" in x;
}

function isAdminForMe(participants: BaileysParticipant[], socketMeJid: string | undefined): boolean {
  const meBare = socketMeJid?.split(":")[0];
  const me = meBare ? `${meBare}@s.whatsapp.net` : undefined;
  if (!me) return false;
  for (const p of participants) {
    const pid = typeof p === "string" ? p : (p as { id: string }).id;
    const pjid = typeof p === "string" ? undefined : hasJid(p) ? p.jid : undefined;
    if (pid === me || pjid === me) {
      if (typeof p === "string") return false;
      const role = (p as { admin?: "admin" | "superadmin" | null }).admin;
      return Boolean(role);
    }
  }
  return false;
}

/**
 * Processes Baileys groups to categorize and select admin-managed groups.
 * - Filters to groups where the bot is an admin (to avoid LIDs-only visibility)
 * - Returns a normalized MinimalGroup list and the subset adminGroups
 * - Optionally could map announce/communities in the future; for now announceGroup is null
 */
export async function processGroupsBaileys(
  sock: WASocket,
  delayMs = 0,
): Promise<{
  groups: MinimalGroup[];
  adminGroups: MinimalGroup[];
  community: MinimalGroup[];
  communityAnnounce: MinimalGroup[];
}> {
  const all = await sock.groupFetchAllParticipating();
  const allGroups = Object.values(all);

  const meJid = sock.user?.id;
  if (!meJid) {
    throw new Error("Socket user JID not available");
  }

  const normalized: MinimalGroup[] = allGroups.map((g: GroupMetadata) => ({
    id: g.id,
    subject: g.subject,
    name: g.subject,
    participants: g.participants as unknown as BaileysParticipant[],
    announceGroup: null,
    addressingMode: g.addressingMode ?? null,
    isCommunity: Boolean(g.isCommunity),
    isCommunityAnnounce: Boolean(g.isCommunityAnnounce),
  }));

  const adminGroups: MinimalGroup[] = [];
  const community: MinimalGroup[] = [];
  const communityAnnounce: MinimalGroup[] = [];
  const groups: MinimalGroup[] = [];

  for (const group of normalized) {
    if (delayMs > 0) {
      const wait = Math.floor(Math.random() * delayMs);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const isAdmin = isAdminForMe(group.participants, meJid);
    const isComm = Boolean(group.isCommunity);
    const isCommAnn = Boolean(group.isCommunityAnnounce);
    // Include non-community announce groups into regular groups as requested
    if (isComm) community.push(group);
    else if (isCommAnn) communityAnnounce.push(group);
    else groups.push(group);

    if (!isComm && !isCommAnn && isAdmin) adminGroups.push(group);
  }

  // Return full classification
  return { groups, adminGroups, community, communityAnnounce };
}

export default { processGroupsBaileys };
