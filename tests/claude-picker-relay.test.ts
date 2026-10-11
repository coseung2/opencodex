import { expect, test } from "bun:test";
import { createPickerRelay } from "../src/claude/intercept/picker-relay";
import { gzipSync } from "node:zlib";
const bootstrap = () => ({ model_selector_config: ["chat", "ccd", "code", "ccr"].map(id => ({ id, models: [{ id: "claude-fixture", name: "Native", section: "main" }] })) });
const models = [{ id: "claude-ocx-fixture--model", name: "Fixture Proxy" }];
test("picker relay pins origin, rewrites Code only and preserves native cookies", async () => {
  let added = 0;
  const dispatch = createPickerRelay({ models: () => models, outcome: result => { if (result.kind === "rewritten") added += result.added; },
    fetchImpl: async (url, init) => {
      expect(String(url)).toBe("https://claude.ai/api/bootstrap/fixture/app_start");
      expect(new Headers(init?.headers).get("cookie")).toBe("fixture-native-session");
      return new Response(gzipSync(Buffer.from(JSON.stringify(bootstrap()))), { headers: { "content-type": "application/json", "content-encoding": "gzip", etag: "fixture" } });
    },
  });
  const response = await dispatch(new Request("https://spoof.invalid/api/bootstrap/fixture/app_start", { headers: { cookie: "fixture-native-session" } }));
  expect(response.headers.has("content-encoding")).toBe(false); expect(response.headers.has("etag")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const document = await response.json();
  expect(document.model_selector_config.map((surface: { models: unknown[] }) => surface.models.length)).toEqual([1, 2, 2, 1]);
  expect(added).toBe(2);
});
test("unknown schema, offline catalog, errors and non-bootstrap responses stay byte-identical", async () => {
  for (const [path, status, payload, rows] of [
    ["/api/bootstrap", 200, '{"unknown":"shape"}', models],
    ["/api/bootstrap", 200, JSON.stringify(bootstrap()), []],
    ["/api/bootstrap", 403, JSON.stringify(bootstrap()), models],
    ["/api/organizations/fixture", 200, JSON.stringify(bootstrap()), models],
  ] as const) {
    const dispatch = createPickerRelay({ models: () => rows, fetchImpl: async () => new Response(payload, { status, headers: { "content-type": "application/json", etag: "kept" } }) });
    const response = await dispatch(new Request(`https://claude.ai${path}`));
    expect(await response.text()).toBe(payload); expect(response.status).toBe(status); expect(response.headers.get("etag")).toBe("kept");
  }
});
test("oversized upstream bootstrap streams unchanged without truncation", async () => {
  const payload = "x".repeat(4 * 1024 * 1024 + 250_000);
  const dispatch = createPickerRelay({ models: () => models, fetchImpl: async () => new Response(payload, { headers: { "content-type": "application/json" } }) });
  expect(await (await dispatch(new Request("https://claude.ai/api/bootstrap"))).text()).toBe(payload);
});
