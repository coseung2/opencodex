import { createHmac, randomBytes } from "node:crypto";

export const CLAUDE_SESSION_SCOPE_HEADER = "x-ocx-claude-session-scope";
const salt = randomBytes(32);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Only known per-session Claude metadata shapes; never a shared prompt-cache key. */
export function claudeSessionScope(headers: Headers, raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as { metadata?: { user_id?: unknown }; messages?: unknown[] };
  const user = body.metadata?.user_id;
  if (typeof user !== "string" || user.length > 4096) return undefined;
  let session: string | undefined;
  try {
    const value = JSON.parse(user);
    if (typeof value?.session_id === "string" && new RegExp(`^${UUID}$`, "i").test(value.session_id)) session = value.session_id;
  } catch { /* legacy user_<id>_account_<id>_session_<uuid> */ }
  session ??= user.match(new RegExp(`_session_(${UUID})$`, "i"))?.[1];
  if (!session) return undefined;
  const firstUser = body.messages?.find(m => !!m && typeof m === "object" && (m as { role?: string }).role === "user");
  if (!firstUser) return undefined;
  // Bind admission identity and the initial user turn as well as the explicit
  // session. Only a process-salted digest leaves this helper; no content is stored.
  return createHmac("sha256", salt).update(JSON.stringify([
    headers.get("x-opencodex-api-key"), headers.get("authorization"), headers.get("x-api-key"),
    session.toLowerCase(), firstUser,
  ])).digest("hex");
}
