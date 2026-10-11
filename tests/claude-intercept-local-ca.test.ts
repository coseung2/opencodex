import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import * as nodeCrypto from "node:crypto";
import { X509Certificate } from "node:crypto";
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CLAUDE_INTERCEPT_CA_COMMON_NAME,
  CLAUDE_INTERCEPT_PERMITTED_DNS_NAME,
  claudeInterceptCaCertPath,
  claudeInterceptStateDir,
  createCertificateAuthority,
  createLocalInterceptCa,
  ensureLocalInterceptCa,
  ensureLocalInterceptCaForStartup,
  issueLocalInterceptLeaf,
  issueServerLeaf,
} from "../src/claude/intercept/local-ca";
import { setLocalCaFileHooksForTests, withLocalCaPublication } from "../src/claude/intercept/local-ca-files";
import { setLocalCaWindowsAclRunnerForTests } from "../src/claude/intercept/local-ca-windows";
import { withLocalCaPublicationLock } from "../src/claude/intercept/publication-lock";
import { resetHardenedStateForTests, setIcaclsRunnerForTests, setPlatformForTests, type IcaclsResult } from "../src/lib/windows-secret-acl";
import { resetWindowsPrincipalForTests, setWindowsPrincipalRunnerForTests } from "../src/lib/windows-user-principal";

const roots: string[] = [];
function fixture(prefix = "ocx-intercept-ca-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
beforeEach(() => {
  if (process.platform !== "win32") return;
  // Unit paths never start icacls or the ACL probe. The native canary is a separate file.
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "S-1-5-21-1-2-3-1001\nfixture\\account" }));
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  setLocalCaWindowsAclRunnerForTests(() => ({
    success: true, exitCode: 0, timedOut: false,
    stdout: JSON.stringify({ owner: "S-1-5-21-1-2-3-1001", protected: true, rules: [{ sid: "S-1-5-21-1-2-3-1001", type: 0, rights: 2032127 }] }),
  }));
  resetHardenedStateForTests();
});
afterEach(() => {
  setLocalCaFileHooksForTests(null);
  setLocalCaWindowsAclRunnerForTests(null);
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  resetHardenedStateForTests();
  resetWindowsPrincipalForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("CA certificate is a self-signed X.509 v3 authority scoped to api.anthropic.com", () => {
  const ca = createLocalInterceptCa();
  const cert = new X509Certificate(ca.certPem);
  expect(cert.ca).toBe(true);
  expect(cert.subject).toContain(`CN=${CLAUDE_INTERCEPT_CA_COMMON_NAME}`);
  expect(cert.issuer).toBe(cert.subject);
  expect(cert.verify(ca.publicKey)).toBe(true);
  expect(cert.checkIssued(cert)).toBe(true);
  expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
  expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000);
  expect(Buffer.from(cert.raw).includes(Buffer.from(CLAUDE_INTERCEPT_PERMITTED_DNS_NAME))).toBe(true);
});

test("temporary authorities can shorten validity without changing the default", () => {
  const short = createCertificateAuthority({ commonName: "temporary fixture", validityDays: 1, permittedDnsNames: ["example.test"] });
  const cert = new X509Certificate(short.certPem);
  expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(86_400_000);
  expect(cert.verify(short.publicKey)).toBe(true);
  const normal = new X509Certificate(createLocalInterceptCa().certPem);
  expect(Date.parse(normal.validTo) - Date.parse(normal.validFrom)).toBe(3650 * 86_400_000);
  for (const validityDays of [0, -1, 0.5, NaN, Infinity, 3651]) {
    expect(() => createCertificateAuthority({ commonName: "invalid fixture", validityDays })).toThrow("validityDays");
  }
});

test("leaf is issued only for api.anthropic.com", () => {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, [CLAUDE_INTERCEPT_PERMITTED_DNS_NAME]);
  const cert = new X509Certificate(leaf.certPem);
  const caCert = new X509Certificate(ca.certPem);
  expect(cert.ca).toBe(false);
  expect(cert.checkIssued(caCert)).toBe(true);
  expect(cert.verify(ca.publicKey)).toBe(true);
  expect(cert.checkHost(CLAUDE_INTERCEPT_PERMITTED_DNS_NAME)).toBe(CLAUDE_INTERCEPT_PERMITTED_DNS_NAME);
  expect(cert.checkHost("example.test")).toBeUndefined();
  expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
  expect(leaf.keyPem).toContain("PRIVATE KEY");
  expect(() => issueLocalInterceptLeaf(ca, ["example.test"])).toThrow("name constraints");
  expect(() => issueLocalInterceptLeaf(ca, [])).toThrow("at least one host");
  const picker = createCertificateAuthority({ commonName: "picker fixture", permittedDnsNames: ["claude.ai"] });
  const pickerLeaf = issueServerLeaf(picker, "picker fixture", ["claude.ai"]);
  expect(new X509Certificate(pickerLeaf.certPem).checkHost("claude.ai")).toBe("claude.ai");
  expect(() => issueServerLeaf(picker, "picker fixture", ["api.anthropic.com"])).toThrow("name constraints");
  expect(() => issueServerLeaf(ca, CLAUDE_INTERCEPT_CA_COMMON_NAME, ["claude.ai"])).toThrow("name constraints");
});

test("two CAs never share a serial or key", () => {
  const a = createLocalInterceptCa();
  const b = createLocalInterceptCa();
  expect(new X509Certificate(a.certPem).serialNumber).not.toBe(new X509Certificate(b.certPem).serialNumber);
  expect(a.keyPem).not.toBe(b.keyPem);
});

test("ensureLocalInterceptCa persists once and reloads the same authority", () => {
  const configDir = fixture();
  const first = ensureLocalInterceptCa(configDir);
  const second = ensureLocalInterceptCa(configDir);
  expect(second.certPem).toBe(first.certPem);
  expect(second.keyPem).toBe(first.keyPem);
  expect(readFileSync(claudeInterceptCaCertPath(configDir), "utf8")).toBe(first.certPem);
  if (process.platform !== "win32") {
    expect(statSync(join(claudeInterceptStateDir(configDir), "ca.key")).mode & 0o777).toBe(0o600);
    expect(statSync(claudeInterceptCaCertPath(configDir)).mode & 0o777).toBe(0o644);
    expect(statSync(claudeInterceptStateDir(configDir)).mode & 0o777).toBe(0o700);
  }
});

test("an unconstrained persisted authority is regenerated", () => {
  const configDir = fixture();
  const first = ensureLocalInterceptCa(configDir);
  const unconstrained = createCertificateAuthority({ commonName: CLAUDE_INTERCEPT_CA_COMMON_NAME });
  writeFileSync(claudeInterceptCaCertPath(configDir), unconstrained.certPem);
  writeFileSync(join(claudeInterceptStateDir(configDir), "ca.key"), unconstrained.keyPem);
  const repaired = ensureLocalInterceptCa(configDir);
  expect(repaired.certPem).not.toBe(first.certPem);
  expect(Buffer.from(new X509Certificate(repaired.certPem).raw).includes(Buffer.from(CLAUDE_INTERCEPT_PERMITTED_DNS_NAME))).toBe(true);
});

test("a corrupt private key regenerates the authority instead of throwing", () => {
  const configDir = fixture();
  const first = ensureLocalInterceptCa(configDir);
  writeFileSync(join(claudeInterceptStateDir(configDir), "ca.key"), "not a key\n");
  const regenerated = ensureLocalInterceptCa(configDir);
  expect(regenerated.certPem).not.toBe(first.certPem);
  expect(new X509Certificate(regenerated.certPem).ca).toBe(true);
  expect(readFileSync(claudeInterceptCaCertPath(configDir), "utf8")).toBe(regenerated.certPem);
});

test("a certificate from a different CA is never loaded with the persisted key", () => {
  const configDir = fixture();
  const first = ensureLocalInterceptCa(configDir);
  writeFileSync(claudeInterceptCaCertPath(configDir), createLocalInterceptCa().certPem);
  const repaired = ensureLocalInterceptCa(configDir);
  expect(repaired.keyPem).not.toBe(first.keyPem);
  const certificate = new X509Certificate(repaired.certPem);
  expect(certificate.checkPrivateKey(repaired.privateKey)).toBe(true);
  expect(certificate.verify(repaired.publicKey)).toBe(true);
});

test("a contending CA publisher cannot read or change a partial pair", () => {
  const configDir = fixture();
  const first = ensureLocalInterceptCa(configDir);
  const dir = claudeInterceptStateDir(configDir);
  withLocalCaPublicationLock(() => {
    writeFileSync(join(dir, "ca.key"), createLocalInterceptCa().keyPem);
    const partialKey = readFileSync(join(dir, "ca.key"), "utf8");
    expect(() => ensureLocalInterceptCa(configDir)).toThrow("client_lifecycle_busy");
    expect(readFileSync(join(dir, "ca.key"), "utf8")).toBe(partialKey);
    expect(readFileSync(claudeInterceptCaCertPath(configDir), "utf8")).toBe(first.certPem);
  }, { lockPath: join(dir, "ca-publication.sqlite") });
  const repaired = ensureLocalInterceptCa(configDir);
  expect(new X509Certificate(repaired.certPem).checkPrivateKey(repaired.privateKey)).toBe(true);
});

test("startup retries CA contention after the publisher releases its lease", async () => {
  const configDir = fixture();
  const first = ensureLocalInterceptCa(configDir);
  const pending = withLocalCaPublicationLock(() => {
    const startup = ensureLocalInterceptCaForStartup(configDir);
    return { startup };
  }, { lockPath: join(claudeInterceptStateDir(configDir), "ca-publication.sqlite") });
  const loaded = await pending.startup;
  expect(loaded.certPem).toBe(first.certPem);
  expect(loaded.keyPem).toBe(first.keyPem);
});

test.skipIf(process.platform === "win32")("local CA rejects a symlink directory without modifying its external target", () => {
  const root = fixture("ocx-ca-files-");
  const outside = fixture("ocx-ca-files-");
  const marker = join(outside, "marker");
  writeFileSync(marker, "external", { mode: 0o640 });
  symlinkSync(outside, claudeInterceptStateDir(root));
  expect(() => ensureLocalInterceptCa(root)).toThrow();
  expect(readdirSync(outside)).toEqual(["marker"]);
  expect(readFileSync(marker, "utf8")).toBe("external");
  expect(statSync(marker).mode & 0o777).toBe(0o640);
});

for (const name of ["ca.key", "ca.pem", "ca-publication.sqlite", "ca-publication.sqlite-journal"]) {
  test.skipIf(process.platform === "win32")(`local CA rejects symlink ${name} before reading or replacing it`, () => {
    const root = fixture("ocx-ca-files-");
    const first = ensureLocalInterceptCa(root);
    const dir = claudeInterceptStateDir(root);
    const outside = join(fixture("ocx-ca-files-"), "external");
    writeFileSync(outside, "external", { mode: 0o640 });
    const path = join(dir, name);
    rmSync(path, { force: true });
    symlinkSync(outside, path);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("external");
    expect(statSync(outside).mode & 0o777).toBe(0o640);
    if (name !== "ca.pem") expect(readFileSync(claudeInterceptCaCertPath(root), "utf8")).toBe(first.certPem);
  });
  test(`local CA rejects nonregular ${name} without deleting it`, () => {
    const root = fixture("ocx-ca-files-");
    ensureLocalInterceptCa(root);
    const path = join(claudeInterceptStateDir(root), name);
    rmSync(path, { force: true });
    mkdirSync(path);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
  });
}

for (const name of ["ca.key", "ca.pem", "ca-publication.sqlite"]) {
  test(`local CA refuses multiply linked ${name} and preserves the external link`, () => {
    const root = fixture("ocx-ca-files-");
    ensureLocalInterceptCa(root);
    const path = join(claudeInterceptStateDir(root), name);
    const outside = join(fixture("ocx-ca-files-"), "linked");
    linkSync(path, outside);
    const original = readFileSync(outside);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(readFileSync(outside)).toEqual(original);
    expect(statSync(path).ino).toBe(statSync(outside).ino);
  });
}

for (const [name, mode] of [["", 0o755], ["ca.key", 0o644], ["ca.pem", 0o666], ["ca-publication.sqlite", 0o644]] as const) {
  test.skipIf(process.platform === "win32")(`local CA refuses unsafe POSIX permissions on ${name || "directory"}`, () => {
    const root = fixture("ocx-ca-files-");
    const ca = ensureLocalInterceptCa(root);
    chmodSync(join(claudeInterceptStateDir(root), name), mode);
    expect(() => ensureLocalInterceptCa(root)).toThrow();
    expect(statSync(join(claudeInterceptStateDir(root), name)).mode & 0o777).toBe(mode);
    expect(readFileSync(claudeInterceptCaCertPath(root), "utf8")).toBe(ca.certPem);
  });
}

test.skipIf(process.platform === "win32")("local CA ignores predictable predecessor temp names and leaves external fixtures intact", () => {
  const root = fixture("ocx-ca-files-");
  const dir = claudeInterceptStateDir(root);
  mkdirSync(dir, { mode: 0o700 });
  const oldTemp = join(dir, `ca.key.${process.pid}.tmp`);
  writeFileSync(oldTemp, "reserved predecessor", { mode: 0o600 });
  const ca = ensureLocalInterceptCa(root);
  expect(readFileSync(oldTemp, "utf8")).toBe("reserved predecessor");
  expect(readFileSync(join(dir, "ca.key"), "utf8")).toBe(ca.keyPem);
  expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([`ca.key.${process.pid}.tmp`]);
});

test("unsafe key is rejected even when its certificate is missing", () => {
  const root = fixture("ocx-ca-files-");
  ensureLocalInterceptCa(root);
  const dir = claudeInterceptStateDir(root);
  unlinkSync(claudeInterceptCaCertPath(root));
  const path = join(dir, "ca.key");
  const external = join(fixture("ocx-ca-files-"), "linked-key");
  linkSync(path, external);
  const before = readFileSync(external);
  expect(() => ensureLocalInterceptCa(root)).toThrow();
  expect(readFileSync(external)).toEqual(before);
  expect(statSync(path).nlink).toBe(2);
});

for (const name of ["", "ca.key", "ca.pem", "ca-publication.sqlite"]) {
  test.skipIf(process.platform === "win32")(`local CA rejects foreign POSIX ownership on ${name || "directory"}`, () => {
    const root = fixture("ocx-ca-files-");
    ensureLocalInterceptCa(root);
    const target = join(claudeInterceptStateDir(root), name);
    const original = filesystem.lstatSync;
    const uid = process.geteuid!();
    const probe = spyOn(filesystem, "lstatSync").mockImplementation((path, options) => {
      const stat = original(path, options);
      if (String(path) !== target) return stat;
      const foreign = Object.create(stat);
      Object.defineProperty(foreign, "uid", { value: options && typeof options === "object" && "bigint" in options && options.bigint ? BigInt(uid + 1) : uid + 1 });
      return foreign;
    });
    try { expect(() => { ensureLocalInterceptCa(root); }).toThrow("safe owner-controlled"); }
    finally { probe.mockRestore(); }
    expect(filesystem.lstatSync(target).uid).toBe(uid);
  });
}

test.skipIf(process.platform === "win32")("local CA rejects a key substituted between inspection and pinned read", () => {
  const root = fixture("ocx-ca-files-");
  ensureLocalInterceptCa(root);
  const path = join(claudeInterceptStateDir(root), "ca.key");
  const external = join(fixture("ocx-ca-files-"), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  setLocalCaFileHooksForTests({ beforeRead(target) {
    if (target !== path) return;
    unlinkSync(path);
    symlinkSync(external, path);
  } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow();
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
});

test.skipIf(process.platform === "win32")("local CA never writes key bytes to a substituted empty temporary path", () => {
  const root = fixture("ocx-ca-files-");
  const external = join(fixture("ocx-ca-files-"), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  let substituted: string | undefined;
  setLocalCaFileHooksForTests({ beforeWrite(path) {
    expect(statSync(path).size).toBe(0);
    substituted = path;
    unlinkSync(path);
    symlinkSync(external, path);
  } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow();
  expect(substituted).toBeDefined();
  expect(lstatSync(substituted!).isSymbolicLink()).toBe(true);
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
});

test.skipIf(process.platform === "win32")("local CA publication refuses a newly substituted destination and preserves its external target", () => {
  const root = fixture("ocx-ca-files-");
  const external = join(fixture("ocx-ca-files-"), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  setLocalCaFileHooksForTests({ beforePublish(path) { symlinkSync(external, path); } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow();
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
  expect(lstatSync(join(claudeInterceptStateDir(root), "ca.key")).isSymbolicLink()).toBe(true);
});

test.skipIf(process.platform === "win32")("a concurrent publisher fails under the lease while both PEM files are staged", () => {
  const root = fixture("ocx-ca-files-");
  const attempts: string[] = [];
  setLocalCaFileHooksForTests({ beforePublish(path) {
    attempts.push(path);
    expect(() => { ensureLocalInterceptCa(root); }).toThrow("client_lifecycle_busy");
  } });
  const first = ensureLocalInterceptCa(root);
  expect(attempts).toHaveLength(2);
  setLocalCaFileHooksForTests(null);
  expect(ensureLocalInterceptCa(root).certPem).toBe(first.certPem);
  expect(ensureLocalInterceptCa(root).keyPem).toBe(first.keyPem);
  expect(readdirSync(claudeInterceptStateDir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test.skipIf(process.platform === "win32")("exclusive nofollow staging refuses a preexisting random-temp symlink", () => {
  const root = fixture("ocx-ca-files-");
  const dir = claudeInterceptStateDir(root);
  mkdirSync(dir, { mode: 0o700 });
  const external = join(fixture("ocx-ca-files-"), "outside");
  writeFileSync(external, "external fixture", { mode: 0o640 });
  const temp = join(dir, `.ca.key.${process.pid}.${"00".repeat(16)}.tmp`);
  symlinkSync(external, temp);
  const random = spyOn(nodeCrypto, "randomBytes").mockReturnValue(Buffer.alloc(16));
  try { expect(() => { ensureLocalInterceptCa(root); }).toThrow(); }
  finally { random.mockRestore(); }
  expect(lstatSync(temp).isSymbolicLink()).toBe(true);
  expect(readFileSync(external, "utf8")).toBe("external fixture");
  expect(statSync(external).mode & 0o777).toBe(0o640);
});

test("filesystem read denial escapes corruption regeneration and preserves the safe pair", () => {
  const root = fixture("ocx-ca-files-");
  const first = ensureLocalInterceptCa(root);
  const key = join(claudeInterceptStateDir(root), "ca.key");
  let writes = 0;
  setLocalCaFileHooksForTests({ beforeRead(path) {
    if (path === key) throw Object.assign(new Error("injected read denial"), { code: "EACCES" });
  }, beforeWrite() { writes++; } });
  expect(() => { ensureLocalInterceptCa(root); }).toThrow("injected read denial");
  expect(writes).toBe(0);
  expect(readFileSync(key, "utf8")).toBe(first.keyPem);
  expect(readFileSync(claudeInterceptCaCertPath(root), "utf8")).toBe(first.certPem);
});

test("local CA rejects a descriptor for a different inode before key bytes are read", () => {
  const root = fixture("ocx-ca-files-");
  ensureLocalInterceptCa(root);
  const key = join(claudeInterceptStateDir(root), "ca.key");
  const external = join(fixture("ocx-ca-files-"), "outside");
  writeFileSync(external, "external fixture", { mode: 0o600 });
  const originalOpen = filesystem.openSync;
  const originalRead = filesystem.readSync;
  let foreignFd: number | undefined;
  let foreignReads = 0;
  const opened = spyOn(filesystem, "openSync").mockImplementation((path, flags, mode) => {
    if (String(path) === key) { foreignFd = originalOpen(external, flags, mode); return foreignFd; }
    return originalOpen(path, flags, mode);
  });
  const reads = spyOn(filesystem, "readSync").mockImplementation((...args) => {
    if (args[0] === foreignFd) foreignReads++;
    return originalRead(...args);
  });
  try { expect(() => { ensureLocalInterceptCa(root); }).toThrow("safe owner-controlled"); }
  finally { reads.mockRestore(); opened.mockRestore(); }
  expect(foreignFd).toBeDefined();
  expect(foreignReads).toBe(0);
  expect(readFileSync(external, "utf8")).toBe("external fixture");
});

const CURRENT = "S-1-5-21-1-2-3-1001";
const FOREIGN = "S-1-5-21-9-8-7-1002";
const FULL_CONTROL = 2032127;
type Rule = { sid: string; type: number; rights: number };
const ok = (stdout = ""): IcaclsResult => ({ success: true, exitCode: 0, timedOut: false, stdout });
const acl = (owner = CURRENT, rules: Rule[] = [{ sid: CURRENT, type: 0, rights: FULL_CONTROL }], protectedDacl = true): IcaclsResult =>
  ok(JSON.stringify({ owner, protected: protectedDacl, rules }));

function windowsFixture() {
  const root = fixture("ocx-ca-windows-");
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: `${CURRENT}\nfixture\\account` }));
  resetHardenedStateForTests();
  const hardened = new Set<string>();
  const emptyTempProtections: string[] = [];
  setIcaclsRunnerForTests(args => {
    if (args[1] === "/grant:r" && args[0]!.endsWith(".tmp")) {
      expect(statSync(args[0]!).size).toBe(0);
      emptyTempProtections.push(args[0]!);
    }
    if (args[1] === "/remove:g") hardened.add(args[0]!);
    return ok();
  });
  setLocalCaWindowsAclRunnerForTests(() => acl());
  const writes: string[] = [];
  const reads: string[] = [];
  const secretWrites: string[] = [];
  const originalWrite = filesystem.writeFileSync;
  const writeSpy = spyOn(filesystem, "writeFileSync").mockImplementation((path, data, options) => {
    if (String(data).includes("PRIVATE KEY")) secretWrites.push(String(path));
    return originalWrite(path, data, options);
  });
  setLocalCaFileHooksForTests({ beforeWrite: path => { writes.push(path); }, beforeRead: path => { reads.push(path); } });
  return { root, hardened, emptyTempProtections, writes, reads, secretWrites, restore: () => writeSpy.mockRestore() };
}

test("Windows local CA protects and verifies empty temps before every PEM write", () => {
  const f = windowsFixture();
  try {
    setLocalCaWindowsAclRunnerForTests(path => {
      const protectedDacl = f.hardened.has(path);
      const inheritedPrivate = /sqlite-(journal|wal|shm)$/.test(path) && f.hardened.has(claudeInterceptStateDir(f.root));
      return acl(CURRENT, [{ sid: protectedDacl || inheritedPrivate ? CURRENT : "S-1-5-32-545", type: 0, rights: FULL_CONTROL }], protectedDacl);
    });
    setLocalCaFileHooksForTests({ beforeWrite: path => {
      expect(f.hardened.has(path)).toBe(true);
      expect(statSync(path).size).toBe(0);
      f.writes.push(path);
    }, beforePublish: path => { f.hardened.add(path); } });
    const first = ensureLocalInterceptCa(f.root);
    expect(f.writes).toHaveLength(2);
    expect(f.secretWrites).toHaveLength(1);
    expect(f.emptyTempProtections).toHaveLength(2);
    expect(readFileSync(join(claudeInterceptStateDir(f.root), "ca.key"), "utf8")).toBe(first.keyPem);
    expect(ensureLocalInterceptCa(f.root).certPem).toBe(first.certPem);
  } finally { f.restore(); }
});

test("Windows effective SID lookup failure occurs before any secret write", () => {
  const f = windowsFixture();
  try {
    setWindowsPrincipalRunnerForTests(() => ({ success: false, exitCode: 1, timedOut: false, stdout: "" }));
    expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
    expect(f.writes).toEqual([]);
    expect(f.secretWrites).toEqual([]);
  } finally { f.restore(); }
});

test("Windows refuses a newly created directory with an Administrators default owner after hardening", () => {
  const f = windowsFixture();
  try {
    const dir = claudeInterceptStateDir(f.root);
    setLocalCaWindowsAclRunnerForTests(path => {
      expect(path).toBe(dir);
      expect(f.hardened.has(dir)).toBe(true);
      return acl("S-1-5-32-544");
    });
    expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
    expect(readdirSync(dir)).toEqual([]);
    expect(f.secretWrites).toEqual([]);
  } finally { f.restore(); }
});

test("Windows allows current SID, SYSTEM and Administrators and harmless Deny entries", () => {
  const f = windowsFixture();
  try {
    setLocalCaWindowsAclRunnerForTests(() => acl(CURRENT, [
      { sid: CURRENT, type: 0, rights: FULL_CONTROL },
      { sid: "S-1-5-18", type: 0, rights: FULL_CONTROL },
      { sid: "S-1-5-32-544", type: 0, rights: FULL_CONTROL },
      { sid: FOREIGN, type: 1, rights: FULL_CONTROL },
    ]));
    const first = ensureLocalInterceptCa(f.root);
    expect(ensureLocalInterceptCa(f.root).keyPem).toBe(first.keyPem);
  } finally { f.restore(); }
});

for (const name of ["claude-intercept", "ca.key", "ca.pem", "ca-publication.sqlite"]) {
  test(`Windows local CA rejects a foreign grant on ${name} before reads or writes`, () => {
    const f = windowsFixture();
    try {
      const first = ensureLocalInterceptCa(f.root);
      f.writes.length = 0;
      f.reads.length = 0;
      f.secretWrites.length = 0;
      f.hardened.clear();
      resetHardenedStateForTests();
      const dir = claudeInterceptStateDir(f.root);
      const target = name === "claude-intercept" ? dir : join(dir, name);
      const keyBefore = readFileSync(join(dir, "ca.key"));
      const certBefore = readFileSync(join(dir, "ca.pem"));
      setLocalCaWindowsAclRunnerForTests(path => basename(path) === name
        ? acl(CURRENT, [{ sid: CURRENT, type: 0, rights: FULL_CONTROL }, { sid: FOREIGN, type: 0, rights: 1 }])
        : acl());
      expect(() => { ensureLocalInterceptCa(f.root); }).toThrow("Windows owner/ACL");
      expect(f.writes).toEqual([]);
      expect(f.secretWrites).toEqual([]);
      expect(f.reads).toEqual([]);
      expect(f.hardened.has(target)).toBe(false);
      expect(readFileSync(join(dir, "ca.key"))).toEqual(keyBefore);
      expect(readFileSync(join(dir, "ca.pem"))).toEqual(certBefore);
      expect(certBefore.toString()).toBe(first.certPem);
    } finally { f.restore(); }
  });
}

test("Windows memo verifies unchanged identities once per publication", () => {
  const f = windowsFixture();
  try {
    const first = ensureLocalInterceptCa(f.root);
    const dir = claudeInterceptStateDir(f.root);
    const inspections: string[] = [];
    setLocalCaWindowsAclRunnerForTests(path => { inspections.push(path); return acl(); });
    withLocalCaPublication(dir, "ca-publication.sqlite", files => {
      expect(files.readPair()).toEqual({ certPem: first.certPem, keyPem: first.keyPem });
      expect(files.readPair()).toEqual({ certPem: first.certPem, keyPem: first.keyPem });
    });
    expect(inspections.filter(path => !/sqlite-(journal|wal|shm)$/.test(path)).map(path => basename(path)).sort())
      .toEqual(["ca-publication.sqlite", "ca.key", "ca.pem", "claude-intercept"]);
    expect(new Set(inspections).size).toBe(inspections.length);
  } finally { f.restore(); }
});

test("Windows foreign grant while protecting a new temp causes zero secret writes", () => {
  const f = windowsFixture();
  try {
    let tempSeen = false;
    setLocalCaWindowsAclRunnerForTests(path => {
      if (!path.endsWith(".tmp")) return acl();
      tempSeen = true;
      expect(statSync(path).size).toBe(0);
      return acl(CURRENT, [{ sid: FOREIGN, type: 0, rights: 2 }]);
    });
    expect(() => { ensureLocalInterceptCa(f.root); }).toThrow();
    expect(tempSeen).toBe(true);
    expect(f.writes).toEqual([]);
    expect(f.secretWrites).toEqual([]);
    const names = readdirSync(claudeInterceptStateDir(f.root));
    expect(names).not.toContain("ca.key");
    expect(names).not.toContain("ca.pem");
  } finally { f.restore(); }
});
