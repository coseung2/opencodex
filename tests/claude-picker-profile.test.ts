import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPickerProfile, removePickerProfile } from "../src/claude/intercept/picker-profile";
test("picker PAC profile retains unrelated settings and restores exact original selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-profile-"));
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const library = join(root, "library"); mkdirSync(library);
  const id = "11111111-1111-1111-1111-111111111111";
  const before = JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex-standard" }], unrelated: true });
  writeFileSync(join(library, "_meta.json"), before);
  writeFileSync(join(library, `${id}.json`), JSON.stringify({ disableAutoUpdates: false }));
  try {
    await applyPickerProfile(root, "http://127.0.0.1:10202/ocx-claude-picker.pac", library);
    const after = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
    expect(JSON.parse(readFileSync(join(library, `${after.appliedId}.json`), "utf8"))).toEqual({ disableAutoUpdates: false, egressProxyPacUrl: "http://127.0.0.1:10202/ocx-claude-picker.pac" });
    await applyPickerProfile(root, "http://127.0.0.1:10202/ocx-claude-picker.pac", library);
    await removePickerProfile(root, library);
    expect(readFileSync(join(library, "_meta.json"), "utf8")).toBe(before);
    expect(readdirSync(library).sort()).toEqual([`${id}.json`, "_meta.json"]);
  } finally { if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalEnv; rmSync(root, { recursive: true, force: true }); }
});
test("picker refuses foreign proxy and preserves user changes on removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-foreign-"));
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const library = join(root, "library"); mkdirSync(library);
  const id = "11111111-1111-1111-1111-111111111111";
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex-standard" }] }));
  const path = join(library, `${id}.json`);
  writeFileSync(path, JSON.stringify({ egressProxyUrl: "http://fixture.invalid" }));
  try {
    await expect(applyPickerProfile(root, "http://127.0.0.1:10202/ocx-claude-picker.pac", library)).rejects.toThrow("picker_profile_foreign_selection");
    expect(readFileSync(path, "utf8")).toContain("fixture.invalid");
    writeFileSync(path, "{}");
    await applyPickerProfile(root, "http://127.0.0.1:10202/ocx-claude-picker.pac", library);
    writeFileSync(join(library, "_meta.json"), '{"userChanged":true}');
    await expect(removePickerProfile(root, library)).rejects.toThrow("picker_profile_changed");
    expect(readFileSync(join(library, "_meta.json"), "utf8")).toBe('{"userChanged":true}');
  } finally { if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = originalEnv; rmSync(root, { recursive: true, force: true }); }
});
