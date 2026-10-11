import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePickerAuthority, acceptsPickerAuthority, PICKER_CA_NAME } from "../src/claude/intercept/picker-authority";
import { createCertificateAuthority, issueServerLeaf } from "../src/claude/intercept/local-ca";
test("picker authority accepts only its short-lived claude.ai DNS constraint", () => {
  const authority = createCertificateAuthority({ commonName: PICKER_CA_NAME, permittedDnsNames: ["claude.ai"], validityDays: 30 });
  expect(acceptsPickerAuthority(authority.certPem)).toBe(true);
  expect(() => issueServerLeaf(authority, PICKER_CA_NAME, ["api.anthropic.com"])).toThrow();
  expect(acceptsPickerAuthority(createCertificateAuthority({ commonName: PICKER_CA_NAME, permittedDnsNames: ["claude.ai", "unrelated.invalid"], validityDays: 30 }).certPem)).toBe(false);
  expect(acceptsPickerAuthority(createCertificateAuthority({ commonName: PICKER_CA_NAME, permittedDnsNames: ["claude.ai"], validityDays: 3650 }).certPem)).toBe(false);
});
test.skipIf(process.platform !== "win32")("Windows picker signing key persists only in DPAPI and is stable across startup", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-dpapi-"));
  try {
    const first = ensurePickerAuthority(root), second = ensurePickerAuthority(root);
    expect(second.certPem).toBe(first.certPem);
    expect(readFileSync(join(root, "picker-ca.dpapi"), "utf8")).not.toContain("PRIVATE KEY");
    expect(readdirSync(root).some(name => name.endsWith(".key"))).toBe(false);
    const original = Date.now;
    Date.now = () => original() + 31 * 24 * 60 * 60 * 1000;
    try {
      expect(() => ensurePickerAuthority(root)).toThrow("picker_ca_store_invalid");
      expect(ensurePickerAuthority(root, true).certPem).toBe(first.certPem);
    } finally { Date.now = original; }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
