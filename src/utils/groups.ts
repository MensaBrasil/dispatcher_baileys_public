import type { WASocket } from "baileys";

type BaileysParticipant = { id: string; admin?: "admin" | "superadmin" | null } | { id: string } | string;

export type MinimalGroup = {
  id: string;
  subject?: string;
  name?: string;
  participants: BaileysParticipant[];
  announceGroup?: string | null;
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
}> {
  const all = await sock.groupFetchAllParticipating();
  const allGroups = Object.values(all);

  const meJid = sock.user?.id;
  if (!meJid) {
    throw new Error("Socket user JID not available");
  }

  const normalized: MinimalGroup[] = allGroups.map((g) => ({
    id: g.id,
    subject: g.subject,
    name: g.subject,
    participants: g.participants as unknown as BaileysParticipant[],
    announceGroup: null,
  }));

  const adminGroups: MinimalGroup[] = [];

  for (const group of normalized) {
    if (delayMs > 0) {
      const wait = Math.floor(Math.random() * delayMs);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (isAdminForMe(group.participants, meJid)) {
      adminGroups.push(group);
    }
  }

  // For now, process only admin groups to ensure real numbers (not LIDs)
  return { groups: adminGroups, adminGroups };
}

export default { processGroupsBaileys };
