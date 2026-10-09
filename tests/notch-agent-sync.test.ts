import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNotchAgentDefs, syncNotchAgentCatalog } from "../src/claude/notch-agent-sync";
import { resolveAlias } from "../src/claude/alias";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "ocx-notch-test-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function catalog() {
  return {
    schemaVersion: 1, source: "remote",
    chosen: ["opencode-go/deepseek-v4.1-flash", "xai/grok-4.7", "gpt-6-astra", "gpt-6.1-sol"],
    injection: { effort: "ultra", available: [
      { provider: "opencode-go", model: "deepseek-v4.1-flash", namespaced: "opencode-go/deepseek-v4.1-flash" },
      { provider: "xai", model: "grok-4.7", namespaced: "xai/grok-4.7" },
      { provider: "openai", model: "gpt-6-astra", namespaced: "gpt-6-astra" },
      { provider: "openai", model: "gpt-6.1-sol", namespaced: "gpt-6.1-sol" },
    ] },
    claudeCode: { enabled: true, injectAgents: true, blockedSkills: [], contextWindows: {}, autoContext: true },
  };
}
test("exact VM featured roster, no self, no Codex effort inference", () => {
  const d = dir();
  writeFileSync(join(d, "settings.json"), JSON.stringify({ model: "some-main-model" }));
  const defs = buildNotchAgentDefs(catalog(), d);
  expect(defs).toHaveLength(4);
  expect(defs.some(def => def.name === "ocx-self")).toBe(false);
  expect(defs.every(def => def.effort === undefined)).toBe(true);
  expect(defs.map(def => resolveAlias(def.model))).toEqual(catalog().chosen);
});
test("raw vendor slash preserved using exact identity mapping", () => {
  const c = catalog();
  c.chosen = ["openrouter/vendor-model"];
  c.injection.available = [{ provider: "openrouter", model: "vendor/model", namespaced: "openrouter/vendor-model" }];
  const [def] = buildNotchAgentDefs(c, dir());
  expect(resolveAlias(def!.model)).toBe("openrouter/vendor/model");
});
test("failed validation preserves files; explicit empty removes generated only", () => {
  const d = dir();
  const files = syncNotchAgentCatalog(catalog(), d);
  const before = readFileSync(join(d, "agents", files[0]!), "utf8");
  for (const bad of [{ ...catalog(), source: "local" }, { ...catalog(), claudeCode: null }, { ...catalog(), chosen: ["missing"] }]) {
    expect(() => syncNotchAgentCatalog(bad, d)).toThrow();
    expect(readFileSync(join(d, "agents", files[0]!), "utf8")).toBe(before);
  }
  writeFileSync(join(d, "agents", "ocx-personal.md"), "personal");
  expect(syncNotchAgentCatalog({ ...catalog(), chosen: [] }, d)).toEqual([]);
  expect(readdirSync(join(d, "agents"))).toEqual(["ocx-personal.md"]);
});
test("identical sync keeps mtime and emits route marker", () => {
  const d = dir();
  const files = syncNotchAgentCatalog(catalog(), d);
  const path = join(d, "agents", files[0]!);
  const time = statSync(path).mtimeMs;
  syncNotchAgentCatalog(catalog(), d);
  expect(statSync(path).mtimeMs).toBe(time);
  expect(readFileSync(path, "utf8")).toContain("<!-- ocx-route: claude-ocx-opencode-go--deepseek-v4.1-flash -->");
});
test("user collision aborts before stale deletion", () => {
  const d = dir();
  const files = syncNotchAgentCatalog(catalog(), d);
  const c = catalog();
  c.chosen = ["xai/new-model"];
  c.injection.available = [{ provider: "xai", model: "new-model", namespaced: "xai/new-model" }];
  writeFileSync(join(d, "agents", "ocx-new-model.md"), "personal");
  expect(() => syncNotchAgentCatalog(c, d)).toThrow("user-owned");
  expect(readFileSync(join(d, "agents", files[0]!), "utf8")).toContain("generated-by");
});
test("remote context metadata controls marking and blocked policy", () => {
  const c = catalog();
  c.claudeCode.contextWindows = { "claude-ocx-native--gpt-6-astra": 1_000_000 };
  c.claudeCode.blockedSkills = ["claude-api"] as never[];
  const defs = buildNotchAgentDefs(c, dir());
  expect(defs.find(def => def.name === "ocx-gpt-6-astra")!.model).toEndWith("[1m]");
  expect(defs.every(def => def.blockedSkills.includes("claude-api"))).toBe(true);
});
test("duplicate identities and malformed policy fail validation", () => {
  const c = catalog();
  c.injection.available.push(c.injection.available[0]!);
  expect(() => buildNotchAgentDefs(c, dir())).toThrow();
  expect(() => buildNotchAgentDefs({ ...catalog(), claudeCode: { injectAgents: "yes" } }, dir())).toThrow();
});
test("disabled injection prunes generated definitions", () => {
  const d = dir(); syncNotchAgentCatalog(catalog(), d);
  const c = catalog(); c.claudeCode.injectAgents = false;
  expect(syncNotchAgentCatalog(c, d)).toEqual([]);
});
