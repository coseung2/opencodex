import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredNamespaceAliases } from "../src/responses/namespace-aliases";
import { isOpenCodeMuseResponses } from "../src/providers/opencode-go-transport";
import { enrichProviderFromRegistry } from "../src/providers/derive";
import { handleResponses } from "../src/server/responses";
import { clearResponseStateMemoryForTests, expandPreviousResponseInput, flushResponseState } from "../src/responses/state";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const oldFetch = globalThis.fetch;
const oldHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-muse-compat-"));
  process.env.OPENCODEX_HOME = home;
  clearResponseStateMemoryForTests();
});
afterEach(async () => {
  globalThis.fetch = oldFetch;
  await flushResponseState();
  clearResponseStateMemoryForTests();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

const model = "muse-spark-1.3-contributor";
const go = "https://opencode.ai/zen/go/v1";
function config(baseUrl = go): OcxConfig {
  return { port: 0, defaultProvider: "fixture", providers: { fixture: {
    adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl,
  } } } as OcxConfig;
}
const tool = { type: "namespace", name: "default", tools: [{ type: "function", name: "apply_patch", parameters: { type: "object" } }] };
async function call(body: Record<string, unknown>, baseUrl = go): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `fixture/${model}`, input: "update the fixture", tools: [tool], ...body }),
  }), config(baseUrl), { model: "", provider: "" });
}

describe("declared namespace alias ownership", () => {
  test("unambiguous dotted and canonical names resolve to the same identity", () => {
    const aliases = declaredNamespaceAliases([{ namespace: "default", name: "apply_patch" }]);
    expect(aliases.get("default.apply_patch")).toEqual({ namespace: "default", name: "apply_patch" });
    expect(aliases.get("default__apply_patch")).toEqual(aliases.get("default.apply_patch"));
  });
  test("dotted collisions and flat canonical owners are declaration-order independent", () => {
    for (const tools of [
      [{ namespace: "a", name: "b.c" }, { namespace: "a.b", name: "c" }],
      [{ namespace: "default", name: "apply_patch" }, { name: "default.apply_patch" }],
    ]) {
      for (const order of [tools, [...tools].reverse()]) {
        const aliases = declaredNamespaceAliases(order);
        expect(aliases.has(tools.length && tools[0].namespace === "a" ? "a.b.c" : "default.apply_patch")).toBe(false);
        expect(aliases.has(`${tools[0].namespace}__${tools[0].name}`)).toBe(true);
      }
    }
  });
  test("separator-bearing dotted forms cannot impersonate canonical names", () => {
    const aliases = declaredNamespaceAliases([
      { namespace: "x__y", name: "z" }, { namespace: "x", name: "y.z" },
    ]);
    expect(aliases.get("x__y.z")).toEqual({ namespace: "x", name: "y.z" });
    expect(aliases.has("x.y__z")).toBe(false);
  });
  test("duplicate identical declarations are harmless, unknown names never appear", () => {
    const aliases = declaredNamespaceAliases([{ namespace: "n", name: "run" }, { namespace: "n", name: "run" }]);
    expect(aliases.size).toBe(2);
    expect(aliases.has("other.run")).toBe(false);
  });
});

describe("OpenCode Muse wire boundary", () => {
  test("compatibility recognizes exact Go/Zen URLs, not reseller names or URL lookalikes", () => {
    for (const base of [go, "https://opencode.ai/zen/v1"]) {
      expect(isOpenCodeMuseResponses(model, `${base}/responses`)).toBe(true);
    }
    const credentialed = new URL(`${go}/responses`);
    credentialed.username = "synthetic-user";
    credentialed.password = "synthetic-password";
    for (const url of [`${go}/responses?q=1`, `${go}/responses#x`, "https://opencode.ai.evil.test/zen/go/v1/responses", credentialed.href, "not a URL"]) {
      expect(isOpenCodeMuseResponses(model, url)).toBe(false);
    }
    expect(isOpenCodeMuseResponses("gpt-5.6-luna", `${go}/responses`)).toBe(false);
  });

  test("real request removes only refused fields at the OpenCode destination", async () => {
    const requests: Record<string, any>[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_search", status: "completed", output: [] });
    }) as typeof fetch;
    const search = { type: "web_search", search_content_types: ["text"], indexed_web_access: true, search_context_size: "low" };
    await (await call({ tools: [search], stream: false })).text();
    await (await call({ tools: [search], stream: false }, "https://custom.test/v1")).text();
    expect(requests[0].tools[0]).toEqual({ type: "web_search", search_context_size: "low" });
    expect(requests[1].tools[0]).toEqual(search);
  });

  test("JSON namespaced calls round-trip without rewriting arguments or unknown names", async () => {
    globalThis.fetch = (async () => Response.json({ id: "resp_alias", status: "completed", output: [
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "default.apply_patch", arguments: '{"text":"default.apply_patch"}' },
      { type: "function_call", id: "fc_2", call_id: "call_2", name: "unknown.tool", arguments: "{}" },
    ] })) as typeof fetch;
    const response = await call({ stream: false });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.output[0]).toMatchObject({ namespace: "default", name: "apply_patch", call_id: "call_1", arguments: '{"text":"default.apply_patch"}' });
    expect(body.output[1].name).toBe("unknown.tool");
    expect(body.output[1].namespace).toBeUndefined();
  });

  test("SSE restores item and terminal snapshots while replay retains raw upstream names", async () => {
    const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "default.apply_patch", arguments: "{}" };
    const events = [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_muse_stream", status: "completed", output: [item] } },
    ];
    globalThis.fetch = (async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const text = await (await call({ stream: true })).text();
    expect(text.match(/"namespace":"default"/g)).toHaveLength(3);
    expect(text).not.toContain('"name":"default.apply_patch"');
    const expanded = expandPreviousResponseInput({ previous_response_id: "resp_muse_stream", input: "next" }) as any;
    expect(expanded.input.some((entry: any) => entry.type === "function_call" && entry.name === "default.apply_patch")).toBe(true);
  });

  test("a custom destination with the same model retains its own tool spelling", async () => {
    globalThis.fetch = (async () => Response.json({ output: [{ type: "function_call", name: "default.apply_patch", arguments: "{}" }] })) as typeof fetch;
    const body = await (await call({ stream: false }, "https://custom.test/v1")).json() as any;
    expect(body.output[0].name).toBe("default.apply_patch");
    expect(body.output[0].namespace).toBeUndefined();
  });
});

describe("persisted provider enrichment", () => {
  test("one customized model does not hide new context metadata or mutate user maps", () => {
    const windows = { "kimi-k3": 123_000, [model]: 456_000 };
    const efforts = { "grok-4.6": [] as string[] };
    const provider = { adapter: "openai-chat", authMode: "key", baseUrl: go, modelContextWindows: windows, modelReasoningEfforts: efforts } as OcxProviderConfig;
    enrichProviderFromRegistry("opencode-go", provider);
    expect(provider.modelContextWindows?.["muse-spark-1.2-contributor"]).toBe(1_048_576);
    expect(provider.modelContextWindows?.[model]).toBe(456_000);
    expect(provider.modelReasoningEfforts?.["grok-4.6"]).toEqual([]);
    expect(provider.modelReasoningEfforts?.["kimi-k3"]).toBeDefined();
    expect(provider.modelInputModalities?.[model]).toEqual(["text", "image"]);
    expect(windows).toEqual({ "kimi-k3": 123_000, [model]: 456_000 });
    expect(efforts).toEqual({ "grok-4.6": [] });
  });
});
