import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocalCaWindowsAclRunnerForTests } from "../src/claude/intercept/local-ca-windows";
import { claudeInterceptProxyTokenPath, ensureClaudeInterceptProxyToken, readClaudeInterceptProxyToken } from "../src/claude/intercept/proxy-auth";
import { resetHardenedStateForTests, setIcaclsRunnerForTests, setPlatformForTests } from "../src/lib/windows-secret-acl";
import { resetWindowsPrincipalForTests, setWindowsPrincipalRunnerForTests } from "../src/lib/windows-user-principal";

const roots: string[] = [];
function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-proxy-auth-"));
  roots.push(root);
  return root;
}
beforeEach(() => {
  if (process.platform !== "win32") return;
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
  setLocalCaWindowsAclRunnerForTests(null);
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  resetHardenedStateForTests();
  resetWindowsPrincipalForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("read returns null without creating anything on disk", () => {
  const root = dir();
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(existsSync(join(root, "claude-intercept"))).toBe(false);
});

test("ensure creates one bounded token and all callers reuse it", () => {
  const root = dir();
  const token = ensureClaudeInterceptProxyToken(root);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(readFileSync(claudeInterceptProxyTokenPath(root), "utf8")).toBe(`${token}\n`);
  expect(ensureClaudeInterceptProxyToken(root)).toBe(token);
  expect(readClaudeInterceptProxyToken(root)).toBe(token);
  expect(readdirSync(join(root, "claude-intercept"))).toEqual(["proxy-token"]);
});

for (const ending of ["", "\n", "\r\n"]) {
  test(`a valid committed credential with ending ${JSON.stringify(ending)} wins`, () => {
    const root = dir();
    ensureClaudeInterceptProxyToken(root);
    writeFileSync(claudeInterceptProxyTokenPath(root), "A".repeat(43) + ending, { mode: 0o600 });
    expect(ensureClaudeInterceptProxyToken(root)).toBe("A".repeat(43));
  });
}

for (const [label, value] of [
  ["empty", ""], ["short", "committed-token"], ["space", "A".repeat(43) + " "],
  ["extra newline", "A".repeat(43) + "\n\n"], ["oversized", "A".repeat(65536)],
  ["non-ascii", "가".repeat(43)],
] as const) {
  test(`invalid ${label} credentials are refused, never overwritten`, () => {
    const root = dir();
    ensureClaudeInterceptProxyToken(root);
    const path = claudeInterceptProxyTokenPath(root);
    writeFileSync(path, value);
    expect(readClaudeInterceptProxyToken(root)).toBeNull();
    expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(value);
    expect(readdirSync(join(root, "claude-intercept"))).toEqual(["proxy-token"]);
  });
}

test("a directory at the credential path is not a credential", () => {
  const root = dir();
  mkdirSync(claudeInterceptProxyTokenPath(root), { recursive: true });
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
  expect(lstatSync(claudeInterceptProxyTokenPath(root)).isDirectory()).toBe(true);
});

test.skipIf(process.platform === "win32")("valid existing token permissions are repaired through its descriptor", () => {
  const root = dir();
  mkdirSync(join(root, "claude-intercept"), { recursive: true });
  const path = claudeInterceptProxyTokenPath(root);
  writeFileSync(path, "B".repeat(43) + "\n", { mode: 0o644 });
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(ensureClaudeInterceptProxyToken(root)).toBe("B".repeat(43));
  expect(statSync(path).mode & 0o077).toBe(0);
});

test.skipIf(process.platform === "win32")("a token symlink never reads or chmods its external target", () => {
  const root = dir();
  const external = join(root, "outside.txt");
  writeFileSync(external, "C".repeat(43) + "\n", { mode: 0o644 });
  const before = statSync(external).mode;
  mkdirSync(join(root, "claude-intercept"), { mode: 0o700 });
  const path = claudeInterceptProxyTokenPath(root);
  symlinkSync(external, path);
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readFileSync(external, "utf8")).toBe("C".repeat(43) + "\n");
  expect(statSync(external).mode).toBe(before);
});

test("a linked credential directory never grants authority", () => {
  const root = dir();
  const external = join(root, "outside-dir");
  mkdirSync(external);
  writeFileSync(join(external, "proxy-token"), "D".repeat(43) + "\n");
  symlinkSync(external, join(root, "claude-intercept"), process.platform === "win32" ? "junction" : "dir");
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
  expect(readFileSync(join(external, "proxy-token"), "utf8")).toBe("D".repeat(43) + "\n");
});

test("a hardlinked credential is refused and the external link is preserved", () => {
  const root = dir();
  const token = ensureClaudeInterceptProxyToken(root);
  const path = claudeInterceptProxyTokenPath(root);
  const outside = join(root, "linked-token");
  filesystem.linkSync(path, outside);
  expect(readClaudeInterceptProxyToken(root)).toBeNull();
  expect(() => ensureClaudeInterceptProxyToken(root)).toThrow();
  expect(readFileSync(outside, "utf8")).toBe(`${token}\n`);
  expect(statSync(path).ino).toBe(statSync(outside).ino);
});

test("a staging link that cannot be removed is not admitted and leaks no private detail", () => {
  const root = dir();
  const original = filesystem.unlinkSync;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const removal = spyOn(filesystem, "unlinkSync").mockImplementation(path => {
    if (String(path).includes(".proxy-token.") && String(path).endsWith(".tmp")) {
      throw Object.assign(new Error("private detail must not escape"), { code: "EACCES" });
    }
    return original(path);
  });
  try {
    expect(() => ensureClaudeInterceptProxyToken(root)).toThrow("owner-controlled");
    expect(readClaudeInterceptProxyToken(root)).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("private detail");
    const temps = readdirSync(join(root, "claude-intercept")).filter(name => name.endsWith(".tmp"));
    expect(temps).toHaveLength(1);
  } finally { removal.mockRestore(); warning.mockRestore(); }
});

test("cleanup errors preserve the original credential creation error", () => {
  const root = dir();
  const originalWrite = filesystem.writeFileSync;
  const originalUnlink = filesystem.unlinkSync;
  const failure = new Error("expected creation failure");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const write = spyOn(filesystem, "writeFileSync").mockImplementation((path, data, options) => {
    if (typeof path === "number") throw failure;
    return originalWrite(path, data, options);
  });
  const removal = spyOn(filesystem, "unlinkSync").mockImplementation(path => {
    if (String(path).includes(".proxy-token.") && String(path).endsWith(".tmp")) {
      throw Object.assign(new Error("secondary removal error"), { code: "EACCES" });
    }
    return originalUnlink(path);
  });
  try {
    let caught: unknown;
    try { ensureClaudeInterceptProxyToken(root); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(readClaudeInterceptProxyToken(root)).toBeNull();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally { removal.mockRestore(); write.mockRestore(); warning.mockRestore(); }
});

test("a temporary close error does not replace the published credential result", () => {
  const root = dir();
  const originalWrite = filesystem.writeFileSync;
  const originalClose = filesystem.closeSync;
  let tempFd = -1;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const write = spyOn(filesystem, "writeFileSync").mockImplementation((path, data, options) => {
    if (typeof path === "number") tempFd = path;
    return originalWrite(path, data, options);
  });
  const close = spyOn(filesystem, "closeSync").mockImplementation(fd => {
    originalClose(fd);
    if (fd === tempFd) {
      tempFd = -1;
      throw new Error("injected post-close error");
    }
  });
  try {
    const token = ensureClaudeInterceptProxyToken(root);
    expect(readClaudeInterceptProxyToken(root)).toBe(token);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(root, "claude-intercept"))).toEqual(["proxy-token"]);
  } finally { close.mockRestore(); write.mockRestore(); warning.mockRestore(); }
});
