import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDesktopFirstParty } from "../src/claude/desktop-first-party";
import { buildClaudeInterceptEnv } from "../src/claude/intercept/settings";
import type { OcxConfig } from "../src/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-1p-")); roots.push(root);
  const settings = JSON.stringify({ unrelated: true, env: { UNRELATED: "keep" } });
  const gateway = JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayApiKey: "fixture-key" });
  const meta = JSON.stringify({ appliedId: "owned", entries: [{ id: "owned", name: "opencodex" }] });
  writeFileSync(join(root, "settings.json"), settings);
  writeFileSync(join(root, "owned.json"), gateway);
  writeFileSync(join(root, "_meta.json"), meta);
  const config = { port: 10100, providers: {}, defaultProvider: "openai", claudeCode: { desktopProfile: { version: 1, assignments: {}, defaults: {}, appliedFingerprint: createHash("sha256").update(gateway).digest("hex").slice(0, 16) } } } as OcxConfig;
  const env = buildClaudeInterceptEnv(10200, join(root, "ca.pem"), "fixture-token");
  return { root, config, env, settings, meta, prepare: async () => ({ env, proxyPort: 10200 }) };
}

describe("explicit Desktop first-party transition", () => {
  test("prepares transport before writes and commits mode after releasing gateway", async () => {
    const f = fixture();
    const result = await applyDesktopFirstParty(f.config, { target: f.root, gateway: { libraryPath: f.root }, prepare: f.prepare, persist: config => {
      expect(JSON.parse(readFileSync(join(f.root, "settings.json"), "utf8")).env.HTTPS_PROXY).toBe(f.env.HTTPS_PROXY);
      expect(JSON.parse(readFileSync(join(f.root, "_meta.json"), "utf8")).appliedId).not.toBe("owned");
      expect(config.claudeCode?.desktopMode).toBe("first-party");
      return true;
    } });
    expect(result).toMatchObject({ ok: true, mode: "first-party", restartRequired: true, proxyPort: 10200 });
    expect(f.config.claudeCode?.desktopProfile?.appliedFingerprint).toBeUndefined();
  });

  test("listener failure leaves all settings and mode unchanged", async () => {
    const f = fixture();
    const result = await applyDesktopFirstParty(f.config, { target: f.root, gateway: { libraryPath: f.root }, prepare: async () => { throw new Error("fixture-secret"); }, persist: () => true });
    expect(result).toEqual({ ok: false, reason: "intercept_unavailable", rollbackComplete: true });
    expect(readFileSync(join(f.root, "settings.json"), "utf8")).toBe(f.settings);
    expect(readFileSync(join(f.root, "_meta.json"), "utf8")).toBe(f.meta);
  });

  test("mode persistence failure rolls back external fields without deleting profile", async () => {
    const f = fixture();
    const original = structuredClone(f.config);
    const result = await applyDesktopFirstParty(f.config, { target: f.root, gateway: { libraryPath: f.root }, prepare: f.prepare, persist: () => false });
    expect(result).toEqual({ ok: false, reason: "mode_persist_failed", rollbackComplete: true });
    expect(f.config).toEqual(original);
    expect(JSON.parse(readFileSync(join(f.root, "settings.json"), "utf8"))).toEqual(JSON.parse(f.settings));
    expect(readFileSync(join(f.root, "_meta.json"), "utf8")).toBe(f.meta);
  });

  test("foreign proxy refuses transition before gateway selection changes", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://foreign", NODE_EXTRA_CA_CERTS: "foreign-ca" } }));
    const result = await applyDesktopFirstParty(f.config, { target: f.root, gateway: { libraryPath: f.root }, prepare: f.prepare, persist: () => true });
    expect(result).toMatchObject({ ok: false, reason: "foreign_env" });
    expect(readFileSync(join(f.root, "_meta.json"), "utf8")).toBe(f.meta);
    expect(f.config.claudeCode?.desktopMode).toBeUndefined();
  });
});
