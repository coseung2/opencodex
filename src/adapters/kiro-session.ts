import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isValidKiroConversationId } from "./kiro-wire";
import type { OcxProviderConfig } from "../types";

export interface KiroSessionLease {
  conversationId: string;
  finish(success: boolean, returnedId?: string): void;
}

/** Bounded process-local state; busy sessions fork instead of sharing an in-flight turn. */
export function createKiroSessionStore(maxEntries = 256, ttlMs = 3_600_000, now = Date.now) {
  const salt = randomBytes(32);
  const entries = new Map<string, { id: string; busy: boolean; at: number }>();
  return {
    acquire(scope: string | null | undefined, provider: OcxProviderConfig, model: string): KiroSessionLease | undefined {
      if (!scope || !/^[a-f0-9]{64}$/.test(scope)) return undefined;
      const key = createHmac("sha256", salt).update(JSON.stringify([scope, provider.baseUrl, provider.apiKey, model])).digest("hex");
      const time = now();
      // Expiring a busy entry allocates a NEW id; an old completion cannot commit
      // into its replacement (object-identity check below). This bounds abandoned leases.
      for (const [k, v] of entries) if (time - v.at >= ttlMs) entries.delete(k);
      let entry = entries.get(key);
      if (entry?.busy) return undefined;
      if (!entry) {
        while (entries.size >= maxEntries) {
          const idle = [...entries].find(([, v]) => !v.busy);
          if (!idle) return undefined;
          entries.delete(idle[0]);
        }
        entry = { id: randomUUID(), busy: false, at: time };
      }
      entry.busy = true;
      entries.delete(key); entries.set(key, entry);
      const owned = entry;
      let finished = false;
      return {
        conversationId: owned.id,
        finish(success: boolean, returnedId?: string) {
          if (finished) return;
          finished = true;
          if (entries.get(key) !== owned) return;
          if (!success) { entries.delete(key); return; }
          if (isValidKiroConversationId(returnedId)) owned.id = returnedId;
          owned.busy = false; owned.at = now();
        },
      };
    },
  };
}

export const kiroClaudeSessions = createKiroSessionStore();
