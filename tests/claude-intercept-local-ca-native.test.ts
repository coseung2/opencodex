/**
 * Real Windows ACL canary. Kept out of the unit file so a 5-second suite never
 * starts PowerShell. Run explicitly: bun test tests/claude-intercept-local-ca-native.test.ts
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalCaWindowsAcl, localCaWindowsPrincipal } from "../src/claude/intercept/local-ca-windows";
import { hardenSecretPath } from "../src/lib/windows-secret-acl";

test.skipIf(process.platform !== "win32")("native ACL inspection rejects an inherited temp file and accepts the same file after a SID harden", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-ca-native-"));
  try {
    const loose = join(root, "inherited.txt");
    writeFileSync(loose, "fixture", { mode: 0o600 });
    expect(() => assertLocalCaWindowsAcl(loose, "private")).toThrow("Windows owner/ACL");
    hardenSecretPath(loose, { required: true, principal: localCaWindowsPrincipal() });
    expect(() => assertLocalCaWindowsAcl(loose, "private")).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
