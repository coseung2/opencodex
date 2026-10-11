import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseDesktopGateway } from "../src/claude/desktop-gateway-release";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-gateway-release-"));
  roots.push(root);
  const gateway = JSON.stringify({ inferenceProvider: "gateway", inferenceGatewayApiKey: "fixture-secret", inferenceGatewayBaseUrl: "http://127.0.0.1:10100", egressProxyUrl: "http://corporate-proxy", unrelated: true });
  const meta = JSON.stringify({ appliedId: "owned", entries: [{ id: "owned", name: "opencodex" }, { id: "foreign", name: "external" }], unrelated: true });
  writeFileSync(join(root, "owned.json"), gateway);
  writeFileSync(join(root, "_meta.json"), meta);
  return { root, gateway, meta, fingerprint: createHash("sha256").update(gateway).digest("hex").slice(0, 16) };
}

describe("Desktop gateway release", () => {
  test("pivots exact owned gateway without deleting credentials or unrelated settings", () => {
    const f = fixture();
    const result = releaseDesktopGateway({ libraryPath: f.root, appliedFingerprint: f.fingerprint });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const meta = JSON.parse(readFileSync(join(f.root, "_meta.json"), "utf8"));
    expect(meta.appliedId).not.toBe("owned");
    expect(meta.entries).toHaveLength(3);
    expect(meta.unrelated).toBe(true);
    const standard = JSON.parse(readFileSync(join(f.root, `${meta.appliedId}.json`), "utf8"));
    expect(standard).toEqual({ egressProxyUrl: "http://corporate-proxy", unrelated: true });
    expect(readFileSync(join(f.root, "owned.json"), "utf8")).toBe(f.gateway);
    expect(result.rollback()).toBe(true);
    expect(readFileSync(join(f.root, "_meta.json"), "utf8")).toBe(f.meta);
  });

  test("requires exact applied fingerprint and refuses foreign selected row", () => {
    const f = fixture();
    expect(releaseDesktopGateway({ libraryPath: f.root }).ok).toBe(false);
    expect(releaseDesktopGateway({ libraryPath: f.root, appliedFingerprint: "wrong" })).toMatchObject({ ok: false, reason: "profile_changed" });
    writeFileSync(join(f.root, "_meta.json"), f.meta.replace('"appliedId":"owned"', '"appliedId":"foreign"'));
    expect(releaseDesktopGateway({ libraryPath: f.root, appliedFingerprint: f.fingerprint })).toMatchObject({ ok: false, reason: "foreign_profile" });
    expect(readFileSync(join(f.root, "owned.json"), "utf8")).toBe(f.gateway);
  });

  test("concurrent metadata changes are preserved", () => {
    const f = fixture();
    const edited = f.meta.replace('"unrelated":true', '"unrelated":false');
    const result = releaseDesktopGateway({ libraryPath: f.root, appliedFingerprint: f.fingerprint, beforeCommit: () => writeFileSync(join(f.root, "_meta.json"), edited) });
    expect(result).toMatchObject({ ok: false, reason: "profile_changed" });
    expect(readFileSync(join(f.root, "_meta.json"), "utf8")).toBe(edited);
  });

  test("rollback never overwrites a later selection", () => {
    const f = fixture();
    const result = releaseDesktopGateway({ libraryPath: f.root, appliedFingerprint: f.fingerprint });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    writeFileSync(join(f.root, "_meta.json"), f.meta.replace('"appliedId":"owned"', '"appliedId":"foreign"'));
    expect(result.rollback()).toBe(false);
  });

  test("unsafe ids and malformed metadata produce bounded diagnostics", () => {
    const f = fixture();
    writeFileSync(join(f.root, "_meta.json"), JSON.stringify({ appliedId: "../outside", entries: [] }));
    expect(releaseDesktopGateway({ libraryPath: f.root, appliedFingerprint: f.fingerprint })).toMatchObject({ ok: false, reason: "unsafe_library" });
    writeFileSync(join(f.root, "_meta.json"), "fixture-secret invalid JSON");
    expect(JSON.stringify(releaseDesktopGateway({ libraryPath: f.root }))).not.toContain("fixture-secret");
  });
});
