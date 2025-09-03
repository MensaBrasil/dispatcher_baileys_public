import type { WASocket, GroupMetadata } from "baileys";

type BaileysParticipant = { id: string; admin?: "admin" | "superadmin" | null } | { id: string } | string;

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

function isAdminForMe(participants: BaileysParticipant[], meJid: string): boolean {
  for (const p of participants) {
    const id = typeof p === "string" ? p : (p as { id?: string }).id;
    if (!id) continue;
    if (id === meJid) {
      if (typeof p === "string") return false; // cannot know, assume not admin
      const role = (p as { admin?: string | null }).admin;
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
