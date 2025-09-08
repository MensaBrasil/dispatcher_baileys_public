import fs from "node:fs/promises";
import path from "node:path";
import { proto } from "baileys";
import logger from "../utils/logger.js";

export interface MessageStoreData {
  version: number;
  updatedAt: string; // ISO
  lastPerGroup: Record<string, number>; // unix seconds
  byId: Record<string, proto.IMessage | undefined>;
  lastKeyPerGroup?: Record<string, { id: string; participant?: string | null }>;
}

export interface MessageStoreOptions {
  filePath?: string;
  autoSaveMs?: number;
}

export class MessageStore {
  private data: MessageStoreData = {
    version: 1,
    updatedAt: new Date().toISOString(),
    lastPerGroup: {},
    byId: {},
    lastKeyPerGroup: {},
  };
  private filePath: string;
  private saveTimer?: NodeJS.Timeout;
  private autoSaveMs: number;

  private constructor(filePath: string, autoSaveMs: number) {
    this.filePath = filePath;
    this.autoSaveMs = autoSaveMs;
  }

  static async create(opts: MessageStoreOptions = {}): Promise<MessageStore> {
    const defaultDir = path.resolve(".state");
    const defaultPath = path.join(defaultDir, "messages_store.json");
    const filePath = opts.filePath ?? defaultPath;
    const autoSaveMs = Math.max(250, opts.autoSaveMs ?? 1000);
    const store = new MessageStore(filePath, autoSaveMs);
    await store.load();
    return store;
  }

  private async ensureDirExists(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    } catch {
      // ignore
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MessageStoreData;
      if (parsed && typeof parsed === "object" && parsed.version) {
        this.data = parsed;
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (!e || e.code !== "ENOENT") {
        logger.warn({ err }, "[msg-store] failed to load, starting fresh");
      }
      // start fresh
      this.data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        lastPerGroup: {},
        byId: {},
        lastKeyPerGroup: {},
      };
      await this.ensureDirExists();
      await this.saveImmediate();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveImmediate().catch((err) => logger.warn({ err }, "[msg-store] autosave failed"));
    }, this.autoSaveMs);
  }

  async saveImmediate(): Promise<void> {
    await this.ensureDirExists();
    const payload = JSON.stringify({ ...this.data, updatedAt: new Date().toISOString() });
    await fs.writeFile(this.filePath, payload, "utf8");
  }

  getLastTimestamp(groupId: string): number {
    return this.data.lastPerGroup[groupId] ?? 0;
  }

  setLastTimestamp(groupId: string, unixSeconds: number): void {
    if (!unixSeconds) return;
    const current = this.data.lastPerGroup[groupId] ?? 0;
    if (unixSeconds > current) {
      this.data.lastPerGroup[groupId] = unixSeconds;
      this.scheduleSave();
    }
  }

  async getMessage(key: { id?: string | null }): Promise<proto.IMessage | undefined> {
    const id = key.id ?? undefined;
    if (!id) return undefined;
    return this.data.byId[id];
  }

  updateFromMessages(
    list: Array<{
      key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null };
      message?: proto.IMessage | null;
      messageTimestamp?: number | Long | null;
    }>,
  ): void {
    for (const m of list) {
      const id = m.key.id ?? undefined;
      if (id && m.message) {
        this.data.byId[id] = m.message;
      }
      const gid = m.key.remoteJid ?? undefined;
      const ts = Number(m.messageTimestamp ?? 0) || 0;
      if (gid && ts) this.setLastTimestamp(gid, ts);

      // Track last message key per group to support read receipts
      if (gid && id && !m.key.fromMe) {
        if (!this.data.lastKeyPerGroup) this.data.lastKeyPerGroup = {};
        this.data.lastKeyPerGroup[gid] = { id, participant: m.key.participant ?? undefined };
      }
    }
    this.scheduleSave();
  }

  getLastKeyForGroup(groupId: string): { id: string; participant?: string | null } | undefined {
    return this.data.lastKeyPerGroup?.[groupId];
  }
}

export default { MessageStore };
