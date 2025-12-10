import type { WASocket, GroupMetadata } from "baileys";

type BaileysParticipant =
  | { id: string; admin?: "admin" | "superadmin" | null; jid?: string; lid?: string; phoneNumber?: string }
  | { id: string }
  | string;

export type MinimalGroup = {
  id: string;
  subject?: string;
  name?: string;
  participants: BaileysParticipant[];
  announceGroup?: string | null;
  linkedParent?: string | null;
  addressingMode?: "pn" | "lid" | string | null;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
  isAdmin?: boolean;
};

function hasJid(x: unknown): x is { jid?: string } {
  return typeof x === "object" && x !== null && "jid" in x;
}

function normalizeUserBase(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const [user] = jid.split("@", 2);
  if (!user) return null;
  const base = user.split(":")[0];
  return base ?? null;
}

function isAdminForMe(participants: BaileysParticipant[], socketMeJid: string | undefined): boolean {
  const meBase = normalizeUserBase(socketMeJid);
  if (!meBase) return false;
  for (const p of participants) {
    const pid = typeof p === "string" ? p : (p as { id: string }).id;
    const pjid = typeof p === "string" ? undefined : hasJid(p) ? p.jid : undefined;
    const baseId = normalizeUserBase(pid) ?? normalizeUserBase(pjid);
    if (baseId && baseId === meBase) {
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
 * - Returns normalized lists for regular, community, and announce groups, plus the admin subsets
 * - Maps announce/linked parent (community id) into announceGroup for downstream removal context
 */
export async function processGroupsBaileys(
  sock: WASocket,
  delayMs = 0,
): Promise<{
  groups: MinimalGroup[];
  adminGroups: MinimalGroup[];
  community: MinimalGroup[];
  communityAnnounce: MinimalGroup[];
  adminCommunity: MinimalGroup[];
  adminCommunityAnnounce: MinimalGroup[];
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
    linkedParent: g.linkedParent ?? null,
    addressingMode: g.addressingMode ?? null,
    isCommunity: Boolean(g.isCommunity),
    isCommunityAnnounce: Boolean(g.isCommunityAnnounce),
    isAdmin: false,
  }));

  // Map comunidade -> grupo de anúncios correspondente
  const announceByCommunity = new Map<string, string>();
  for (const group of normalized) {
    if (group.isCommunityAnnounce && group.linkedParent) {
      announceByCommunity.set(group.linkedParent, group.id);
    }
  }

  const adminGroups: MinimalGroup[] = [];
  const adminCommunity: MinimalGroup[] = [];
  const adminCommunityAnnounce: MinimalGroup[] = [];
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
    group.isAdmin = isAdmin;
    // Aponta sempre para o grupo de anúncios da comunidade
    if (isCommAnn) {
      group.announceGroup = group.id;
    } else if (group.linkedParent) {
      group.announceGroup = announceByCommunity.get(group.linkedParent) ?? null;
    } else {
      group.announceGroup = null;
    }
    // Classify into regular/community/announce buckets
    if (isComm) community.push(group);
    else if (isCommAnn) communityAnnounce.push(group);
    else groups.push(group);

    if (isAdmin) {
      if (isComm) adminCommunity.push(group);
      else if (isCommAnn) adminCommunityAnnounce.push(group);
      else adminGroups.push(group);
    }
  }

  // Return full classification
  return { groups, adminGroups, community, communityAnnounce, adminCommunity, adminCommunityAnnounce };
}

export default { processGroupsBaileys };
