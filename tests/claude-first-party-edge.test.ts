import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { buildFirstPartyCatalog } from "../src/claude/first-party-catalog";
import { pickerPresentationModels } from "../src/claude/picker-presentation";
import { isClaudeWebSearchHelper } from "../src/claude/web-search-helper";
test("search helper identification tolerates the native billing prefix but not arbitrary mentions", () => {
  const tools = [{ type: "web_search_20250305", name: "web_search" }];
  expect(isClaudeWebSearchHelper({ tools, system: "x-anthropic-billing-header: fixture\nYou are an assistant for performing a web search tool use" })).toBe(true);
  expect(isClaudeWebSearchHelper({ tools, system: "Ordinary task mentioning You are an assistant for performing a web search tool use" })).toBe(false);
  expect(isClaudeWebSearchHelper({ tools: [], system: "You are an assistant for performing a web search tool use" })).toBe(false);
});
import { classifyFirstPartyEdgeClient, isFirstPartySecurityClassifier, createFirstPartyEdgeDispatcher, FIRST_PARTY_EDGE_MAX_BODY_BYTES, type FirstPartyEdgeConnection } from "../src/claude/first-party-edge";
const NOW = 1800000000000;
function fixture() {
  let connection: FirstPartyEdgeConnection = { connected: true, bindingId: "fixture-vm" };
  let bound = { bindingId: "fixture-vm", snapshot: buildFirstPartyCatalog([{ provider: "fixture", id: "model" }], { modelMap: { alias: "fixture/model", "claude-fixture": "fixture/model" } }, NOW) };
  const calls: { kind: string; request: Request; model?: string }[] = [];
  const dispatch = createFirstPartyEdgeDispatcher({ relayOrigin: "http://127.0.0.1:32100", connection: () => connection, readSnapshot: () => bound, now: () => NOW,
    relay: async (request, decision) => { calls.push({ kind: "relay", request, model: decision.model }); return new Response("relay"); },
    native: async request => { calls.push({ kind: "native", request }); return new Response("native"); },
  });
  const request = (body: unknown, path = "/v1/messages", headers: Record<string, string> = {}) => new Request(`https://untrusted.example${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer fixture-secret", "x-api-key": "fixture-api-secret", ...headers } });
  return { dispatch, calls, request, bound, disconnect: () => { connection = { connected: false, bindingId: null }; }, rebind: () => { connection = { connected: true, bindingId: "different-vm" }; } };
}
test("unmapped native subscription ignores disconnected/stale VM", async () => {
  const f = fixture(); f.disconnect(); f.bound.snapshot.generatedAt = NOW - 300001; f.bound.snapshot.expiresAt = NOW - 1;
  expect(await (await f.dispatch(f.request({ model: "claude-unmapped[1m]" }))).text()).toBe("native");
  expect(f.calls[0]!.request.url).toBe("https://api.anthropic.com/v1/messages");
  expect(f.calls[0]!.request.headers.get("authorization")).toBe("Bearer fixture-secret");
  expect(f.calls[0]!.request.headers.get("x-api-key")).toBe("fixture-api-secret");
});

test("routed continuation is negotiated locally before relay, native threads remain native", async () => {
  for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
    const f = fixture();
    const response = await f.dispatch(f.request({ model: "alias", thread: { type: "continue", previous_message_id: "msg_old" }, messages: [] }, path));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: { error_code: "thread_unsupported_request" } } });
    expect(f.calls).toHaveLength(0);
    expect((await f.dispatch(f.request({ model: "claude-unmapped", thread: { type: "continue" } }, path))).status).toBe(200);
    expect(f.calls[0]!.kind).toBe("native");
  }
});

test("dedicated WebSearch helper uses only the explicitly bound route and strips native auth", async () => {
  const snapshot = buildFirstPartyCatalog([{ provider: "native", id: "gpt-6.1-sol", reasoningEfforts: ["low"] }], {}, NOW);
  const calls: Request[] = [];
  const dispatch = createFirstPartyEdgeDispatcher({ relayOrigin: "http://127.0.0.1:32100", webSearchHelperModel: "gpt-6.1-sol",
    connection: () => ({ connected: true, bindingId: "test" }), readSnapshot: () => ({ bindingId: "test", snapshot }), now: () => NOW,
    relay: async request => { calls.push(request); return new Response("routed"); }, native: async () => new Response("native"),
  });
  const body = { model: "claude-haiku-5-5", system: "You are an assistant for performing a web search tool use", tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [{ role: "user", content: "Search" }] };
  const response = await dispatch(new Request("https://fixture/v1/messages", { method: "POST", body: JSON.stringify(body), headers: { authorization: "native-secret", cookie: "session" } }));
  expect(await response.text()).toBe("routed");
  expect(calls[0]!.headers.get("authorization")).toBeNull(); expect(calls[0]!.headers.get("cookie")).toBeNull();
  expect((await calls[0]!.json()).model).toBe(snapshot.models[0]!.id);
  expect(await (await dispatch(new Request("https://fixture/v1/messages", { method: "POST", body: JSON.stringify({ ...body, system: "Ordinary Claude task" }) }))).text()).toBe("native");
});

test("explicit native Luna search helper does not require making it a visible main-session model", async () => {
  const snapshot = buildFirstPartyCatalog([{ provider: "native", id: "gpt-6.1-sol" }], {}, NOW);
  let sent: any;
  const dispatch = createFirstPartyEdgeDispatcher({ relayOrigin: "http://127.0.0.1:32100", webSearchHelperModel: "gpt-6-luna",
    connection: () => ({ connected: true, bindingId: "test" }), readSnapshot: () => ({ bindingId: "test", snapshot }), now: () => NOW,
    relay: async request => { sent = await request.json(); return new Response("ok"); }, native: async () => new Response("native"),
  });
  const response = await dispatch(new Request("https://fixture/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-haiku-5-5",
    system: "You are an assistant for performing a web search tool use", tools: [{ type: "web_search_20250305" }], messages: [{ role: "user", content: "search" }] }) }));
  expect(response.status).toBe(200);
  expect(sent.model).toBe("claude-ocx-native--gpt-6-luna");
  expect(snapshot.models).toHaveLength(1);
});

test("effort-capable presentation alias relays its verified source selector, never native auth", async () => {
  const f = fixture(), presentation = pickerPresentationModels(f.bound.snapshot.models)[0]!;
  const encoded = gzipSync(Buffer.from(JSON.stringify({ model: presentation.id, messages: [{ role: "user", content: "Continue" }], output_config: { effort: "high" } })));
  const response = await f.dispatch(new Request("http://fixture/v1/messages", { method: "POST", body: encoded, headers: { "content-encoding": "gzip", authorization: "fixture-secret" } }));
  expect(response.status).toBe(200);
  expect(f.calls[0]!.kind).toBe("relay");
  expect(f.calls[0]!.request.headers.get("authorization")).toBeNull();
  expect(f.calls[0]!.request.headers.get("content-encoding")).toBeNull();
  expect(await f.calls[0]!.request.json()).toMatchObject({ model: presentation.sourceId, output_config: { effort: "high" } });
  f.disconnect(); expect((await f.dispatch(f.request({ model: presentation.id }))).status).toBe(503);
  const unknown = fixture(); expect((await unknown.dispatch(unknown.request({ model: "claude-opus-4-8-zzz" }))).status).toBe(503);
  expect(unknown.calls).toHaveLength(0);
});
test("mapped alias, catalog alias and system marker relay without Anthropic credentials", async () => {
  for (const body of [{ model: "alias" }, { model: fixture().bound.snapshot.models[0]!.id }, { model: "claude-fixture", system: "<!-- ocx-route: fixture/model -->" }]) {
    const f = fixture(); const response = await f.dispatch(f.request(body, "/v1/messages/count_tokens", { cookie: "fixture-session", "proxy-authorization": "fixture-proxy", "user-agent": "unknown-client" }));
    expect(await response.text()).toBe("relay"); const call = f.calls[0]!;
    expect(call.request.url).toBe("http://127.0.0.1:32100/v1/messages/count_tokens"); expect(call.model).toBe("fixture/model");
    for (const key of ["authorization", "x-api-key", "cookie", "proxy-authorization"]) expect(call.request.headers.get(key)).toBeNull();
    expect(await call.request.json()).toEqual(body);
  }
});
test("disconnected, binding mismatch, stale and unknown routes fail with no native fallback", async () => {
  for (const mode of ["disconnect", "binding", "stale", "unknown"]) {
    const f = fixture(); if (mode === "disconnect") f.disconnect(); if (mode === "binding") f.rebind(); if (mode === "stale") f.bound.snapshot.expiresAt = NOW;
    const response = await f.dispatch(f.request({ model: mode === "unknown" ? "unlisted/model" : "alias" }));
    expect(response.status).toBe(503); expect(f.calls).toHaveLength(0); expect(await response.text()).not.toContain("fixture-secret");
  }
});
test("mapped native slot and dated native slot require bound VM and reject stale/disconnected", async () => {
  for (const model of ["claude-fixture", "claude-fixture-20261010"]) {
    const f = fixture(); expect(await (await f.dispatch(f.request({ model }))).text()).toBe("relay");
    f.disconnect(); expect((await f.dispatch(f.request({ model }))).status).toBe(503);
    const stale = fixture(); stale.bound.snapshot.expiresAt = NOW; expect((await stale.dispatch(stale.request({ model }))).status).toBe(503); expect(stale.calls).toHaveLength(0);
  }
});
test("security classifier native exception is system-only and disabled when tools are present", async () => {
  const system = "You are a security monitor for autonomous AI coding agents.";
  const f = fixture(); f.disconnect();
  expect(await (await f.dispatch(f.request({ model: "claude-fixture", system }))).text()).toBe("native");
  expect(isFirstPartySecurityClassifier({ messages: [{ role: "user", content: system }] })).toBe(false);
  expect(isFirstPartySecurityClassifier({ system, tools: [{ name: "fixture" }] })).toBe(false);
  expect(isFirstPartySecurityClassifier({ system: [{ type: "text", text: system }], tools: [] })).toBe(true);
  expect((await f.dispatch(f.request({ model: "claude-fixture", messages: [{ role: "user", content: system }] }))).status).toBe(503);
});
test("callback failures are sanitized rather than leaking authentication data", async () => {
  const dispatch = createFirstPartyEdgeDispatcher({ relayOrigin: "http://127.0.0.1:32100", connection: () => ({ connected: false, bindingId: null }), readSnapshot: () => null,
    relay: async () => { throw new Error("fixture-secret"); }, native: async () => { throw new Error("fixture-secret"); } });
  for (const path of ["/v1/messages", "/v1/other"]) {
    const response = await dispatch(new Request(`http://fixture${path}`, { method: "POST", body: JSON.stringify({ model: "claude-unmapped" }) }));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("fixture-secret");
  }
});
test("gzip is bounded for classification and original compressed bytes remain unchanged", async () => {
  const f = fixture(), encoded = gzipSync(Buffer.from(JSON.stringify({ model: "alias" })));
  const response = await f.dispatch(new Request("http://fixture/v1/messages", { method: "POST", body: encoded, headers: { "content-encoding": "gzip", authorization: "fixture-secret" } }));
  expect(response.status).toBe(200); expect(Buffer.from(await f.calls[0]!.request.arrayBuffer())).toEqual(encoded);
  expect(f.calls[0]!.request.headers.get("content-encoding")).toBe("gzip");
  expect((await f.dispatch(new Request("http://fixture/v1/messages", { method: "POST", body: Buffer.alloc(FIRST_PARTY_EDGE_MAX_BODY_BYTES + 1) }))).status).toBe(413);
  expect((await f.dispatch(f.request({ model: "alias" }, "/v1/messages", { "content-encoding": "br" }))).status).toBe(415);
});
test("other paths use fixed native origin but management paths are denied", async () => {
  const f = fixture(); expect((await f.dispatch(f.request({ model: "alias" }, "/v1/other"))).status).toBe(200);
  expect(f.calls[0]!.kind).toBe("native"); expect(f.calls[0]!.request.url).toBe("https://api.anthropic.com/v1/other");
  expect((await f.dispatch(f.request({}, "/api/settings"))).status).toBe(404); expect(f.calls).toHaveLength(1);
  expect(() => createFirstPartyEdgeDispatcher({ relayOrigin: "http://foreign.example:32100", connection: () => ({ connected: false, bindingId: null }), readSnapshot: () => null, relay: async () => new Response(), native: async () => new Response() })).toThrow("invalid_first_party_relay_origin");
});
test("client classifier is independent of routing and aborted requests invoke neither callback", async () => {
  expect(classifyFirstPartyEdgeClient("claude-cli/2.1.0 (external, claude-desktop)" )).toBe("desktop");
  expect(classifyFirstPartyEdgeClient("claude-cli/2.1.0 (external, cli)" )).toBe("cli");
  expect(classifyFirstPartyEdgeClient("unknown")).toBe("unknown");
  const f = fixture(), controller = new AbortController(); controller.abort();
  const request = new Request("http://fixture/v1/messages", { method: "POST", body: JSON.stringify({ model: "alias" }), signal: controller.signal });
  expect((await f.dispatch(request)).status).toBe(499); expect(f.calls).toHaveLength(0);
});
test("cancellation during bounded body read cancels input and never reaches relay", async () => {
  const f = fixture(), controller = new AbortController(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(source) { source.enqueue(new TextEncoder().encode('{"model":')); queueMicrotask(() => controller.abort()); },
    cancel() { cancelled = true; },
  });
  const response = await f.dispatch(new Request("http://fixture/v1/messages", { method: "POST", body: stream, signal: controller.signal }));
  expect(response.status).toBe(499); expect(cancelled).toBe(true); expect(f.calls).toHaveLength(0);
});
