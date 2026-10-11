import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyClaudeInterceptSettings, buildClaudeInterceptEnv, captureClaudeInterceptSettingsRollback,
  CLAUDE_SETTINGS_MAX_BYTES, claudeInterceptProxyUrl, inspectClaudeInterceptSettings,
  migrateClaudeInterceptSettings, removeClaudeInterceptSettings,
} from "../src/claude/intercept/settings";
const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ocx-settings-fixture-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const CA = "/fixture/ocx/claude-intercept/ca.pem";
const env = buildClaudeInterceptEnv(8846, CA, "fixture-token");
function put(dir: string, doc: unknown) { writeFileSync(join(dir, "settings.json"), JSON.stringify(doc)); }
function read(dir: string) { return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); }

test("explicit config environment selects fixture custom CLAUDE_CONFIG_DIR and is never mutated", () => {
  const dir = fixture(), target = { CLAUDE_CONFIG_DIR: dir, HOME: "/unused-fixture-home" };
  expect(inspectClaudeInterceptSettings(env, target)).toEqual({ kind: "absent" });
  expect(applyClaudeInterceptSettings(env, target)).toMatchObject({ ok: true, changed: true });
  expect(read(dir)).toEqual({ env });
  expect(applyClaudeInterceptSettings(env, target)).toMatchObject({ ok: true, changed: false });
  expect(inspectClaudeInterceptSettings(env, target)).toEqual({ kind: "applied", env });
  expect(target).toEqual({ CLAUDE_CONFIG_DIR: dir, HOME: "/unused-fixture-home" });
});
test("apply and remove preserve unrelated document and environment edits", () => {
  const dir = fixture();
  put(dir, { model: "fixture-model", permissions: { allow: [] }, env: { KEEP: "before" } });
  expect(applyClaudeInterceptSettings(env, dir).ok).toBe(true);
  put(dir, { ...read(dir), theme: "dark", env: { ...read(dir).env, KEEP: "after" } });
  expect(removeClaudeInterceptSettings(CA, dir)).toMatchObject({ ok: true, changed: true });
  expect(read(dir)).toEqual({ model: "fixture-model", permissions: { allow: [] }, theme: "dark", env: { KEEP: "after" } });
  expect(removeClaudeInterceptSettings(CA, dir)).toMatchObject({ ok: true, changed: false });
});
test("migration repairs owned legacy pair but does not enable absent settings", () => {
  const dir = fixture();
  expect(migrateClaudeInterceptSettings(env, dir)).toMatchObject({ ok: true, changed: false });
  expect(existsSync(join(dir, "settings.json"))).toBe(false);
  put(dir, { env: { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA, KEEP: "yes" } });
  expect(inspectClaudeInterceptSettings(env, dir).kind).toBe("stale");
  expect(migrateClaudeInterceptSettings(env, dir)).toMatchObject({ ok: true, changed: true });
  expect(read(dir)).toEqual({ env: { ...env, KEEP: "yes" } });
});
test("foreign values, partial foreign blocks and non-string managed values are not overwritten", () => {
  for (const foreign of [
    { HTTPS_PROXY: "http://fixture-corporate:3128" },
    { NODE_EXTRA_CA_CERTS: "/fixture/foreign-ca.pem" },
    { HTTPS_PROXY: "http://127.0.0.1:8846", NODE_EXTRA_CA_CERTS: "/fixture/foreign-ca.pem" },
    { HTTPS_PROXY: "http://fixture-corporate:3128", NODE_EXTRA_CA_CERTS: CA },
    { HTTPS_PROXY: null, NODE_EXTRA_CA_CERTS: CA },
    { HTTPS_PROXY: 123 },
  ]) {
    const dir = fixture(); put(dir, { env: foreign });
    const before = readFileSync(join(dir, "settings.json"), "utf8");
    expect(inspectClaudeInterceptSettings(env, dir).kind).toBe("foreign");
    expect(applyClaudeInterceptSettings(env, dir)).toMatchObject({ ok: false, reason: "foreign_env" });
    expect(migrateClaudeInterceptSettings(env, dir)).toMatchObject({ ok: false, reason: "foreign_env" });
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before);
  }
});
test("remove preserves a newer foreign proxy and CA pair wholly", () => {
  const dir = fixture();
  put(dir, { env: { HTTPS_PROXY: "http://fixture-corporate:3128", NODE_EXTRA_CA_CERTS: CA } });
  expect(removeClaudeInterceptSettings(CA, dir)).toMatchObject({ ok: true, changed: false });
  expect(read(dir)).toEqual({ env: { HTTPS_PROXY: "http://fixture-corporate:3128", NODE_EXTRA_CA_CERTS: CA } });
  put(dir, { env: { ...env, NODE_EXTRA_CA_CERTS: "/fixture/foreign-ca.pem" } });
  expect(removeClaudeInterceptSettings(CA, dir)).toMatchObject({ ok: true, changed: false });
});
test("malformed, non-object, invalid env and oversized JSON are rejected byte-for-byte", () => {
  for (const raw of ["{bad", "[]", "null", '{"env":null}', '{"env":[]}', '{"env":"wrong"}', " ".repeat(CLAUDE_SETTINGS_MAX_BYTES + 1)]) {
    const dir = fixture(); writeFileSync(join(dir, "settings.json"), raw);
    expect(inspectClaudeInterceptSettings(env, dir).kind).toBe("unreadable");
    expect(applyClaudeInterceptSettings(env, dir)).toMatchObject({ ok: false, reason: "unreadable" });
    expect(removeClaudeInterceptSettings(CA, dir)).toMatchObject({ ok: false, reason: "unreadable" });
    expect(captureClaudeInterceptSettingsRollback(env, dir)()).toBe(false);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(raw);
  }
});
test("rollback restores only captured keys, resolves applied env lazily, and is single-use", () => {
  const dir = fixture(), previous = { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA };
  put(dir, { env: previous });
  let resolved = false;
  const rollback = captureClaudeInterceptSettingsRollback(() => { resolved = true; return env; }, dir);
  expect(resolved).toBe(false);
  expect(applyClaudeInterceptSettings(env, dir).ok).toBe(true);
  put(dir, { theme: "dark", env: { ...env, NEW: "retained" } });
  expect(rollback()).toBe(true);
  expect(resolved).toBe(true);
  expect(read(dir)).toEqual({ theme: "dark", env: { ...previous, NEW: "retained" } });
  expect(rollback()).toBe(false);
});
test("rollback from absent settings preserves newer unrelated changes and drops empty managed env", () => {
  const dir = fixture(), rollback = captureClaudeInterceptSettingsRollback(env, dir);
  applyClaudeInterceptSettings(env, dir);
  put(dir, { theme: "dark", env });
  expect(rollback()).toBe(true);
  expect(read(dir)).toEqual({ theme: "dark" });
});
test("rollback refuses a newer managed proxy or CA and missing/malformed current file", () => {
  for (const newer of [{ ...env, HTTPS_PROXY: "http://127.0.0.1:12000" }, { ...env, NODE_EXTRA_CA_CERTS: "/fixture/new-ca.pem" }]) {
    const dir = fixture(), rollback = captureClaudeInterceptSettingsRollback(env, dir);
    applyClaudeInterceptSettings(env, dir); put(dir, { env: newer });
    expect(rollback()).toBe(false); expect(read(dir)).toEqual({ env: newer });
  }
});
test("rollback refuses missing or malformed current settings and explicit homes never fall back", () => {
  const dir = fixture(), rollback = captureClaudeInterceptSettingsRollback(env, dir);
  expect(rollback()).toBe(false);
  applyClaudeInterceptSettings(env, dir);
  writeFileSync(join(dir, "settings.json"), "{bad");
  expect(rollback()).toBe(false);
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("{bad");
  expect(() => inspectClaudeInterceptSettings(env, {})).toThrow("Explicit Claude settings home required");
  expect(() => inspectClaudeInterceptSettings(env, "")).toThrow("Explicit Claude settings target required");
});
test("cooperating writer lock prevents apply, removal and rollback without touching settings", () => {
  const dir = fixture(), rollback = captureClaudeInterceptSettingsRollback(env, dir);
  applyClaudeInterceptSettings(env, dir);
  writeFileSync(join(dir, "settings.json.ocx-intercept.lock"), "");
  expect(applyClaudeInterceptSettings(env, dir)).toMatchObject({ ok: false, reason: "concurrent_update" });
  expect(removeClaudeInterceptSettings(CA, dir)).toMatchObject({ ok: false, reason: "concurrent_update" });
  expect(rollback()).toBe(false); expect(read(dir)).toEqual({ env });
});
test("hard-linked settings and parent junctions never grant mutation authority", () => {
  const dir = fixture(), original = join(dir, "original.json"), target = join(dir, "linked");
  writeFileSync(original, JSON.stringify({ env }));
  // Parent exists before creating the link; no actual user home is involved.
  const second = fixture();
  linkSync(original, join(second, "settings.json"));
  expect(inspectClaudeInterceptSettings(env, second).kind).toBe("unreadable");
  expect(removeClaudeInterceptSettings(CA, second)).toMatchObject({ ok: false, reason: "unreadable" });
  expect(readFileSync(original, "utf8")).toBe(JSON.stringify({ env }));
  symlinkSync(second, target, process.platform === "win32" ? "junction" : "dir");
  expect(applyClaudeInterceptSettings(env, target)).toMatchObject({ ok: false, reason: "unreadable" });
});
test("parameter errors and write failures never expose tokens", () => {
  const token = "fixture-secret-token";
  for (const port of [0, 65536, 1.5, NaN]) {
    try { claudeInterceptProxyUrl(port, token); throw new Error("expected validation"); }
    catch (error) { expect(String(error)).not.toContain(token); }
  }
  expect(claudeInterceptProxyUrl(8846, "fixture:@/token")).toBe("http://opencodex:fixture%3A%40%2Ftoken@127.0.0.1:8846");
  const dir = fixture(); writeFileSync(join(dir, "not-directory"), "");
  const result = applyClaudeInterceptSettings(env, join(dir, "not-directory", "child"));
  expect(result).toMatchObject({ ok: false, reason: "unreadable" });
  expect(JSON.stringify(result)).not.toContain("fixture-token");
});
