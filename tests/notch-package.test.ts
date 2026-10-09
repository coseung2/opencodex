import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NOTCH_PACKAGE_RELATIVE,
  NOTCH_SOURCE_RELATIVE,
  sha256File,
  stageNotchBinary,
} from "../scripts/notch-package";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-notch-package-"));
  roots.push(root);
  return root;
}

function writeFakePe(path: string, fill = 0x2a): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.alloc(40 * 1024, fill);
  bytes.write("MZ", 0, "ascii");
  writeFileSync(path, bytes);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ocx-notch package staging", () => {
  test("copies Cargo's release executable to the deterministic package path", () => {
    const root = temporaryRoot();
    const source = join(root, NOTCH_SOURCE_RELATIVE);
    const destination = join(root, NOTCH_PACKAGE_RELATIVE);
    writeFakePe(source);

    const staged = stageNotchBinary(root);

    expect(staged.path).toBe(destination);
    expect(staged.copiedFromBuild).toBe(true);
    expect(staged.size).toBe(40 * 1024);
    expect(staged.sha256).toBe(sha256File(source));
    expect(readFileSync(destination)).toEqual(readFileSync(source));
  });

  test("accepts a downloaded CI artifact and fails closed on malformed assets", () => {
    const root = temporaryRoot();
    const destination = join(root, NOTCH_PACKAGE_RELATIVE);
    writeFakePe(destination, 0x11);
    expect(stageNotchBinary(root)).toMatchObject({
      path: destination,
      copiedFromBuild: false,
      size: 40 * 1024,
    });

    writeFileSync(destination, Buffer.from("not a PE"));
    expect(() => stageNotchBinary(root)).toThrow("not a plausible release executable");
    rmSync(destination, { force: true });
    expect(() => stageNotchBinary(root)).toThrow("missing ocx-notch release executable");
  });

  test("root package exposes all three commands and includes the native asset", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      files: string[];
      publishConfig?: { access?: string; tag?: string };
    };
    expect(pkg.name).toBe("@coseung2/opencodex");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(pkg.bin).toEqual({
      opencodex: "./bin/ocx.mjs",
      ocx: "./bin/ocx.mjs",
      "ocx-notch": "./bin/ocx-notch.mjs",
    });
    expect(pkg.files).toContain("vendor/ocx-notch/win32-x64/ocx-notch.exe");
    expect(pkg.publishConfig).toEqual({ access: "public", tag: "next" });

    const launcher = readFileSync("bin/ocx-notch.mjs", "utf8");
    expect(launcher).toContain('"vendor"');
    expect(launcher).toContain('"ocx-notch.exe"');
    expect(launcher).toContain("@coseung2/opencodex");
    expect(launcher).toContain("OCX_PACKAGE_VERSION: packageVersion()");
    expect(launcher).toContain('process.argv.includes("--subagent-catalog")');
    expect(launcher).toContain('["--subagent-catalog-output", output]');
    expect(launcher).toContain('mkdtempSync(join(tmpdir(), "ocx-notch-catalog-")');
    expect(launcher).toContain("could not read the delegation catalog");
    // The scratch directory must be removed before the process exits.
    expect(launcher).toContain("maxRetries: 5");
    expect(launcher).toContain("could not remove the scratch directory");
    expect(launcher.indexOf("rmSync(scratch")).toBeLessThan(launcher.lastIndexOf("process.exit(status)"));
    expect(launcher).not.toContain("@coseung2/ocx-notch");

    const version = spawnSync(process.execPath, ["bin/ocx-notch.mjs", "--version"], {
      encoding: "utf8",
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(
      `ocx-notch 0.1.1 (bundled with @coseung2/opencodex ${pkg.version})`,
    );
  });

  test("catalog queries remove their scratch directory even when they fail", () => {
    if (process.platform !== "win32") return; // the launcher ships for Windows only
    const root = temporaryRoot();
    const launcherPath = join(root, "bin", "ocx-notch.mjs");
    const nativePath = join(root, "vendor", "ocx-notch", "win32-x64", "ocx-notch.exe");
    const scratchRoot = join(root, "scratch");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(dirname(nativePath), { recursive: true });
    mkdirSync(scratchRoot, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@coseung2/opencodex", version: "0.0.0-test" }),
    );
    writeFileSync(launcherPath, readFileSync("bin/ocx-notch.mjs"));
    // Any Windows executable stands in for the native companion: the behaviour
    // under test is the cleanup around a failed query, not the query itself.
    copyFileSync(process.execPath, nativePath);

    const result = spawnSync(process.execPath, [launcherPath, "--subagent-catalog"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not read the delegation catalog");
    expect(readdirSync(scratchRoot)).toEqual([]);

    const quotas = spawnSync(process.execPath, [launcherPath, "--provider-quotas"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot },
    });
    expect(quotas.status).not.toBe(0);
    expect(quotas.stderr).toContain("could not read provider quotas on the selected connection");
    expect(readdirSync(scratchRoot)).toEqual([]);
    const conflict = spawnSync(process.execPath, [launcherPath, "--provider-quotas", "--local"], { encoding: "utf8" });
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("cannot be combined");
  });

  test("native context menu keeps its foreground guard and Korean labels", () => {
    const source = readFileSync("packages/ocx-notch/src/main.rs", "utf8");
    expect(source).toContain("context_menu_open: bool");
    expect(source).toContain("if !context_menu_open");
    expect(source).toContain("with_app(|app| app.context_menu_open = true)");
    expect(source).toContain('w!("사용량 전환 기준")');
    expect(source).toContain('w!("요청 내 오류 전환")');
    expect(source).toContain('w!("기본 쿨다운")');
    expect(source).toContain('w!("프로바이더 추가...")');
    expect(source).toContain('w!("새로고침")');
    expect(source).toContain('w!("종료")');
  });
});
