import { gunzipSync } from "node:zlib";
import { parseFirstPartyCatalog, type FirstPartyCatalogSnapshot } from "./first-party-catalog";
import { selectFirstPartyRoute } from "./first-party-route";
import { extractOcxRouteDirective, resolveInboundModel } from "./inbound";
import { stripOneMillionMarker } from "./context-windows";
import { pickerPresentationModels } from "./picker-presentation";
import { carriesMessageThread, messageThreadUnsupportedResponse } from "./message-threads";
import { isClaudeWebSearchHelper } from "./web-search-helper";
import { claudeCodeNativeAlias } from "./alias";
import { claudeBackgroundHelperKind } from "./background-helper";
export const FIRST_PARTY_NATIVE_ORIGIN = "https://api.anthropic.com";
export const FIRST_PARTY_EDGE_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const FIRST_PARTY_EDGE_MAX_DECODED_BYTES = 16 * 1024 * 1024;
export type FirstPartyEdgeClient = "desktop" | "cli" | "unknown";
/** Client classification never determines whether a requested model is native. */
export function classifyFirstPartyEdgeClient(userAgent: string | null): FirstPartyEdgeClient {
  const entrypoint = userAgent?.match(/^claude-cli\/[^\s()]+ \(external, ([A-Za-z0-9._-]+)(?:, [^,()]+)*\)$/)?.[1];
  if (!entrypoint) return "unknown";
  return ["claude-desktop", "claude-desktop-3p", "local-agent"].includes(entrypoint) ? "desktop" : "cli";
}
export function isFirstPartySecurityClassifier(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (record.tools !== undefined && (!Array.isArray(record.tools) || record.tools.length !== 0)) return false;
  const texts = typeof record.system === "string" ? [record.system] : Array.isArray(record.system)
    ? record.system.flatMap(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text as string] : []) : [];
  return texts.some(text => text.trimStart().startsWith("You are a security monitor for autonomous AI coding agents."));
}
export interface FirstPartyEdgeConnection { connected: boolean; bindingId: string | null }
export interface FirstPartyEdgeBoundCatalog { bindingId: string; snapshot: FirstPartyCatalogSnapshot }
export interface FirstPartyEdgeOptions {
  /** Fixed Notch relay address, validated once; no request-controlled destinations. */
  relayOrigin: string;
  connection(): FirstPartyEdgeConnection;
  readSnapshot(): FirstPartyEdgeBoundCatalog | null;
  relay(request: Request, decision: { model: string; client: FirstPartyEdgeClient; bindingId: string }): Promise<Response>;
  native(request: Request, client: FirstPartyEdgeClient): Promise<Response>;
  /** Explicit helper route supplied by the companion from the bound model catalog. */
  webSearchHelperModel?: string;
  backgroundHelperModel?: string;
  now?: () => number;
}
function relayOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid_first_party_relay_origin");
  return url.origin;
}
const failure = (status: number, reason: string) => new Response(JSON.stringify({ error: { type: "first_party_edge_error", message: reason } }), { status, headers: { "content-type": "application/json" } });
async function boundedBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > FIRST_PARTY_EDGE_MAX_BODY_BYTES)) throw new RangeError("body_limit");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (request.signal.aborted) throw new Error("cancelled");
      const { value, done } = await reader.read();
      if (request.signal.aborted) throw new Error("cancelled");
      if (done) break;
      total += value.length;
      if (total > FIRST_PARTY_EDGE_MAX_BODY_BYTES) throw new RangeError("body_limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { request.signal.removeEventListener("abort", abort); try { await reader.cancel(); } catch { /* closed stream */ } reader.releaseLock(); }
}
function forwarded(request: Request, origin: string, headers: Headers, bytes?: Uint8Array): Request {
  const input = new URL(request.url), target = `${origin}${input.pathname}${input.search}`;
  headers.delete("host"); headers.delete("proxy-authorization");
  return new Request(target, { method: request.method, headers, signal: request.signal,
    ...(request.method !== "GET" && request.method !== "HEAD" ? { body: bytes ? bytes.slice().buffer : request.body } : {}) });
}
/** Dedicated dispatcher only: no OCX runtime startup, worker lifecycle, CA or settings access. */
export function createFirstPartyEdgeDispatcher(options: FirstPartyEdgeOptions): (request: Request) => Promise<Response> {
  const relay = relayOrigin(options.relayOrigin);
  return async request => {
    if (request.signal.aborted) return failure(499, "cancelled");
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) return failure(404, "management_unavailable");
    const client = classifyFirstPartyEdgeClient(request.headers.get("user-agent"));
    if (path !== "/v1/messages" && path !== "/v1/messages/count_tokens") {
      try { return await options.native(forwarded(request, FIRST_PARTY_NATIVE_ORIGIN, new Headers(request.headers)), client); }
      catch { return failure(request.signal.aborted ? 499 : 502, request.signal.aborted ? "cancelled" : "native_unavailable"); }
    }
    if (request.method !== "POST") return failure(405, "method_not_allowed");
    let bytes: Uint8Array, body: unknown;
    try {
      bytes = await boundedBody(request);
      const encoding = request.headers.get("content-encoding")?.trim().toLowerCase() || "identity";
      const decoded = encoding === "identity" ? bytes : encoding === "gzip" || encoding === "x-gzip" ? gunzipSync(bytes, { maxOutputLength: FIRST_PARTY_EDGE_MAX_DECODED_BYTES }) : null;
      if (!decoded) return failure(415, "unsupported_encoding");
      if (decoded.length > FIRST_PARTY_EDGE_MAX_DECODED_BYTES) return failure(413, "body_limit");
      body = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(decoded));
    } catch (error) { return failure(request.signal.aborted ? 499 : error instanceof RangeError ? 413 : 400, request.signal.aborted ? "cancelled" : "invalid_or_oversized_body"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).model !== "string") return failure(400, "invalid_request");
    const model = stripOneMillionMarker((body as { model: string }).model);
    const searchHelper = !!options.webSearchHelperModel && isClaudeWebSearchHelper(body);
    const backgroundHelper = !!options.backgroundHelperModel && claudeBackgroundHelperKind(body);
    const helperModel = searchHelper ? options.webSearchHelperModel : backgroundHelper ? options.backgroundHelperModel : undefined;
    const presentationAlias = /^claude-opus-4-8-[a-z][0-9a-z]{2}$/i.test(model);
    if (isFirstPartySecurityClassifier(body) && !presentationAlias && !/^claude-ocx/i.test(model) && /^claude-[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(model)) {
      try { return await options.native(forwarded(request, FIRST_PARTY_NATIVE_ORIGIN, new Headers(request.headers), bytes), client); }
      catch { return failure(request.signal.aborted ? 499 : 502, request.signal.aborted ? "cancelled" : "native_unavailable"); }
    }
    let bound: FirstPartyEdgeBoundCatalog | null;
    try { bound = options.readSnapshot(); } catch { return failure(503, "catalog_unavailable"); }
    // Retained mappings participate even when stale/disconnected: never fall back to
    // subscription auth for a previously configured VM route.
    let mapped = false;
    if (bound) {
      try {
        const retained = parseFirstPartyCatalog(bound.snapshot, options.now?.() ?? Date.now());
        mapped = pickerPresentationModels(retained.models).some(row => row.id === model)
          || resolveInboundModel(model, { modelMap: retained.modelMap }) !== model;
      } catch { return failure(503, "catalog_unavailable"); }
    }
    if (!helperModel && !mapped && !presentationAlias && !extractOcxRouteDirective(body) && !/^claude-ocx/i.test(model) && /^claude-[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(model)) {
      try { return await options.native(forwarded(request, FIRST_PARTY_NATIVE_ORIGIN, new Headers(request.headers), bytes), client); }
      catch { return failure(request.signal.aborted ? 499 : 502, request.signal.aborted ? "cancelled" : "native_unavailable"); }
    }
    let connection: FirstPartyEdgeConnection;
    try { connection = options.connection(); } catch { return failure(503, "catalog_unavailable"); }
    if (!connection.connected || !connection.bindingId) return failure(503, "vm_disconnected");
    if (!bound || bound.bindingId !== connection.bindingId) return failure(503, "catalog_binding_mismatch");
    const now = options.now?.() ?? Date.now();
    let snapshot: FirstPartyCatalogSnapshot;
    try { snapshot = parseFirstPartyCatalog(bound.snapshot, now); } catch { return failure(503, "catalog_unavailable"); }
    if (snapshot.expiresAt <= now) return failure(503, "catalog_stale");
    const presentation = pickerPresentationModels(snapshot.models).find(row => row.id === model);
    // The operator-selected native Luna helper can be hidden from the ordinary
    // picker. This exception is only for the dedicated WebSearch request, under
    // the same live connection/binding checks; request fields cannot choose it.
    const helper = helperModel ? snapshot.models.find(row => row.route === helperModel)
      ?? (helperModel === "gpt-6-luna"
        ? { id: claudeCodeNativeAlias("gpt-6-luna"), route: "gpt-6-luna" } : undefined) : undefined;
    if (helperModel && !helper) return failure(503, "web_search_helper_unavailable");
    const routedBody = helper ? { ...body, model: helper.id } : presentation ? { ...body, model: presentation.sourceId } : body;
    const decision = selectFirstPartyRoute(routedBody, { modelMap: snapshot.modelMap }, snapshot, now, !helper);
    if (decision.kind !== "routed") return failure(503, decision.kind === "unavailable" ? decision.reason : "route_not_available");
    // Negotiate before forwarding a delta upload. Native Anthropic returned above
    // keeps its server-side threads; routed models must resend complete history.
    if (carriesMessageThread(body)) return messageThreadUnsupportedResponse();
    // Recheck the binding after snapshot resolution before committing to the relay.
    let current: FirstPartyEdgeConnection;
    try { current = options.connection(); } catch { return failure(503, "vm_disconnected"); }
    if (!current.connected || current.bindingId !== connection.bindingId) return failure(503, "vm_disconnected");
    if (request.signal.aborted) return failure(499, "cancelled");
    const headers = new Headers(request.headers);
    for (const key of ["authorization", "x-api-key", "cookie", "proxy-authorization", "x-opencodex-api-key", "x-ocx-api-key"]) headers.delete(key);
    if (presentation || helper) {
      bytes = new TextEncoder().encode(JSON.stringify(routedBody));
      if (bytes.length > FIRST_PARTY_EDGE_MAX_DECODED_BYTES) return failure(413, "body_limit");
      headers.delete("content-encoding"); headers.delete("content-length");
    }
    try { return await options.relay(forwarded(request, relay, headers, bytes), { model: decision.model, client, bindingId: connection.bindingId }); }
    catch { return failure(request.signal.aborted ? 499 : 502, request.signal.aborted ? "cancelled" : "relay_unavailable"); }
  };
}
