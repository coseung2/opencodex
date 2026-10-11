import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NativeReasoning } from "../responses/reasoning-envelope";

// Ephemeral process key: a restart safely drops opaque replay rather than trusting
// client-supplied provider state. No credentials or request bodies are persisted.
const key = randomBytes(32);
export interface NativeReasoningState {
  replay: ReadonlyMap<string, NativeReasoning>;
  mint?: (enc: string, id?: string) => NativeReasoning;
}
const states = new WeakMap<object, NativeReasoningState>();
export function attachNativeReasoningState(parsed: object, state: NativeReasoningState): void { states.set(parsed, state); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Called only by the actual Responses adapter, after destination/auth selection. */
export function projectNativeReasoning(parsed: object, body: unknown, url: string, headers: Record<string, string>): unknown {
  const state = states.get(parsed);
  if (!state || !record(body) || typeof body.model !== "string") return body;
  // Bind to all outgoing headers, not merely a configured key: pool and OAuth retries
  // select credentials at this boundary. Ignore non-identity session/cache headers.
  const identityHeaders = Object.entries(headers).filter(([name]) =>
    !["content-type", "session_id", "x-session-id", "x-client-request-id", "x-request-id"].includes(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a!.localeCompare(b!));
  const owner = createHmac("sha256", key).update(JSON.stringify([url, body.model, identityHeaders])).digest("hex");
  const tag = (enc: string, id?: string) => createHmac("sha256", key).update(owner)
    .update(`:${Buffer.byteLength(id ?? "")}:`).update(id ?? "")
    .update(`:${Buffer.byteLength(enc)}:`).update(enc).digest("hex");
  state.mint = (enc, id) => ({ enc, model: body.model as string, tag: tag(enc, id), ...(id ? { id } : {}) });
  if ((parsed as { _stripReasoningEncryptedContent?: boolean })._stripReasoningEncryptedContent === true
    || !Array.isArray(body.input) || state.replay.size === 0) return body;
  return { ...body, input: body.input.flatMap(item => {
    if (!record(item) || item.type !== "reasoning" || typeof item.id !== "string") return [item];
    const replay = state.replay.get(item.id);
    if (!replay) return [item];
    const visibleOnly = () => Array.isArray(item.summary) && item.summary.length > 0 ? [item] : [];
    if (replay.model !== body.model || !/^[a-f0-9]{64}$/.test(replay.tag)) return visibleOnly();
    const expected = Buffer.from(tag(replay.enc, replay.id), "hex"), actual = Buffer.from(replay.tag, "hex");
    if (!timingSafeEqual(expected, actual)) return visibleOnly();
    return [{ ...item, ...(replay.id ? { id: replay.id } : {}), encrypted_content: replay.enc }];
  }) };
}
