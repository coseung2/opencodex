import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectOpenCodeGoPoolKey, clearOpenCodeGoPoolObservations } from "../src/providers/opencode-go-pool";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
let oldHome: string | undefined;
let home: string;
beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-go-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearOpenCodeGoPoolObservations();
  clearKeyCooldowns();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOpenCodeGoPoolObservations();
  clearKeyCooldowns();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

function config(): OcxConfig {
  return { providers: { "opencode-go": {
    adapter: "openai-responses", authMode: "key", baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "fixture-key-a", apiKeyPool: [
      { id: "a", key: "fixture-key-a", addedAt: 1 },
      { id: "b", key: "fixture-key-b", addedAt: 2 },
    ],
  } } } as OcxConfig;
}
function usage(window?: string, reset = Date.now() + 3_600_000): Response {
  return Response.json({ usage: Object.fromEntries(["rolling", "weekly", "monthly"].map(name =>
    [name, { percent: name === window ? 100 : 10, resetsAt: reset }])) });
}
async function call(cfg: OcxConfig, model = "muse-spark-1.3-contributor"): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", "session_id": "fixture-conversation" },
    body: JSON.stringify({ model: `opencode-go/${model}`, input: "Reply OK", stream: false }),
  }), cfg, { model: "", provider: "" });
}
function completed(): Response {
  return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [] });
}

test.each(["rolling", "weekly", "monthly"])("Go skips a %s-exhausted key before a Muse request", async window => {
  const cfg = config();
  const sent: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const key = new Headers(init?.headers).get("authorization")!;
    if (String(input).endsWith("/usage")) return usage(key.endsWith("-a") ? window : undefined);
    sent.push(key);
    return completed();
  }) as typeof fetch;
  const result = await call(cfg);
  expect(result.status).toBe(200);
  await result.text();
  expect(sent).toEqual(["Bearer fixture-key-b"]);
  expect(cfg.providers["opencode-go"]!.apiKey).toBe("fixture-key-b");
});

test("native Responses 429 rotates Go keys and rebuilds the same request", async () => {
  const cfg = config();
  const sent: Array<{ key: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/usage")) return usage();
    const key = new Headers(init?.headers).get("authorization")!;
    sent.push({ key, body: JSON.parse(String(init?.body)) });
    return key.endsWith("-a") ? Response.json({ error: { message: "Usage limit exceeded" } }, { status: 429 }) : completed();
  }) as typeof fetch;
  const response = await call(cfg);
  expect(response.status).toBe(200);
  await response.text();
  expect(sent.map(item => item.key)).toEqual(["Bearer fixture-key-a", "Bearer fixture-key-b"]);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
});

test("all exhausted keys return a bounded retry hint without sending inference", async () => {
  const cfg = config();
  let inference = 0;
  globalThis.fetch = (async input => {
    if (String(input).endsWith("/usage")) return usage("rolling");
    inference++;
    return completed();
  }) as typeof fetch;
  const response = await call(cfg);
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  await response.text();
  expect(inference).toBe(0);
});

test("failed usage probes preserve selection and never treat an estimate as exhaustion", async () => {
  const cfg = config();
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  const result = await selectOpenCodeGoPoolKey(cfg, "opencode-go", cfg.providers["opencode-go"]!);
  expect(result.unavailable).not.toBe(true);
  expect(cfg.providers["opencode-go"]!.apiKey).toBe("fixture-key-a");
});

test("a passed reset time makes a key eligible even when the snapshot still says 100", async () => {
  const cfg = config();
  globalThis.fetch = (async () => usage("rolling", Date.now() - 1)) as typeof fetch;
  const result = await selectOpenCodeGoPoolKey(cfg, "opencode-go", cfg.providers["opencode-go"]!);
  expect(result.unavailable).not.toBe(true);
  expect(cfg.providers["opencode-go"]!.apiKey).toBe("fixture-key-a");
});

test("concurrent probes coalesce and an administrative selection is not overwritten", async () => {
  const cfg = config();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; await gate; return usage("rolling"); }) as typeof fetch;
  const first = selectOpenCodeGoPoolKey(cfg, "opencode-go", cfg.providers["opencode-go"]!);
  const second = selectOpenCodeGoPoolKey(cfg, "opencode-go", cfg.providers["opencode-go"]!);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(calls).toBe(1);
  cfg.providers["opencode-go"]!.apiKey = "operator-replacement";
  release();
  await Promise.all([first, second]);
  expect(cfg.providers["opencode-go"]!.apiKey).toBe("operator-replacement");
});

test("custom destinations and single-key providers never send Go usage probes", async () => {
  const cfg = config();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return usage(); }) as typeof fetch;
  const provider = cfg.providers["opencode-go"]!;
  await selectOpenCodeGoPoolKey(cfg, "opencode-go", { ...provider, baseUrl: "https://example.invalid/v1" });
  await selectOpenCodeGoPoolKey(cfg, "opencode-go", { ...provider, apiKeyPool: provider.apiKeyPool!.slice(0, 1) });
  expect(calls).toBe(0);
});

test("concurrent exhaustion reuses the healthy replacement instead of sending the old key", async () => {
  const cfg = config();
  const route = { ...cfg.providers["opencode-go"]! };
  globalThis.fetch = (async (_input, init) => usage(
    new Headers(init?.headers).get("authorization")!.endsWith("-a") ? "rolling" : undefined,
  )) as typeof fetch;
  const results = await Promise.all([
    selectOpenCodeGoPoolKey(cfg, "opencode-go", { ...route }),
    selectOpenCodeGoPoolKey(cfg, "opencode-go", { ...route }),
  ]);
  for (const result of results) {
    expect(result.unavailable).not.toBe(true);
    if (!result.unavailable) expect(result.provider.apiKey).toBe("fixture-key-b");
  }
});

test("a 429 on every key is bounded and does not cycle back to the first key", async () => {
  const cfg = config();
  let sends = 0;
  globalThis.fetch = (async input => {
    if (String(input).endsWith("/usage")) return usage();
    sends++;
    return Response.json({ error: { message: "Usage limit exceeded" } }, { status: 429 });
  }) as typeof fetch;
  const response = await call(cfg);
  expect(response.status).toBe(429);
  await response.text();
  expect(sends).toBe(2);
});

test("reactive recovery cannot return to a key already excluded by authoritative usage", async () => {
  const cfg = config();
  const sent: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const key = new Headers(init?.headers).get("authorization")!;
    if (String(input).endsWith("/usage")) return usage(key.endsWith("-a") ? "monthly" : undefined);
    sent.push(key);
    return new Response(null, { status: 429 });
  }) as typeof fetch;
  const response = await call(cfg);
  expect(response.status).toBe(429);
  await response.text();
  expect(sent).toEqual(["Bearer fixture-key-b"]);
});

test.each([false, true])("Go Chat transport also rotates (reactive=%s)", async reactive => {
  const cfg = config();
  cfg.providers["opencode-go"]!.adapter = "openai-chat";
  const sent: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const key = new Headers(init?.headers).get("authorization")!;
    if (String(input).endsWith("/usage")) return usage(!reactive && key.endsWith("-a") ? "rolling" : undefined);
    sent.push(key);
    if (key.endsWith("-a")) return new Response(null, { status: 429 });
    return Response.json({ id: "chatcmpl_fixture", object: "chat.completion", choices: [
      { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
    ], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
  const response = await call(cfg, "mimo-v2.5");
  expect(response.status).toBe(200);
  await response.text();
  expect(sent).toEqual(reactive ? ["Bearer fixture-key-a", "Bearer fixture-key-b"] : ["Bearer fixture-key-b"]);
});

test("Go rotation resolves environment keys without replacing their stored references", async () => {
  const cfg = config();
  const provider = cfg.providers["opencode-go"]!;
  const oldA = process.env.OCX_GO_POOL_TEST_A;
  const oldB = process.env.OCX_GO_POOL_TEST_B;
  process.env.OCX_GO_POOL_TEST_A = "fixture-key-a";
  process.env.OCX_GO_POOL_TEST_B = "fixture-key-b";
  provider.apiKey = "$OCX_GO_POOL_TEST_A";
  provider.apiKeyPool![0]!.key = "$OCX_GO_POOL_TEST_A";
  provider.apiKeyPool![1]!.key = "$OCX_GO_POOL_TEST_B";
  const sent: string[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith("/usage")) return usage();
      const key = new Headers(init?.headers).get("authorization")!;
      sent.push(key);
      return key.endsWith("-a") ? new Response(null, { status: 429 }) : completed();
    }) as typeof fetch;
    const response = await call(cfg);
    expect(response.status).toBe(200);
    await response.text();
    expect(sent).toEqual(["Bearer fixture-key-a", "Bearer fixture-key-b"]);
    expect(provider.apiKey).toBe("$OCX_GO_POOL_TEST_B");
  } finally {
    if (oldA === undefined) delete process.env.OCX_GO_POOL_TEST_A;
    else process.env.OCX_GO_POOL_TEST_A = oldA;
    if (oldB === undefined) delete process.env.OCX_GO_POOL_TEST_B;
    else process.env.OCX_GO_POOL_TEST_B = oldB;
  }
});
