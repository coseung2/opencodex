import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const bindRacePreloadPath = fileURLToPath(new URL("./fixtures/cli-start-bind-race-preload.ts", import.meta.url));
const preferredProbePreloadPath = fileURLToPath(new URL("./fixtures/cli-start-preferred-probe-preload.ts", import.meta.url));
const homes: string[] = [];

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function directorySnapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), "utf8")]));
}

async function runStart(
  home: string,
  codexHome: string,
  options: { preload?: string; env?: Record<string, string> } = {},
) {
  const childArgs = [process.execPath];
  if (options.preload) childArgs.push("--preload", options.preload);
  childArgs.push(cliPath, "start");
  const child = Bun.spawn(childArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCODEX_HOME: home,
      CODEX_HOME: codexHome,
      CODEX_CI: "1",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 25_000);
  try {
    const status = await child.exited;
    return { status, stdout: await stdoutPromise, stderr: await stderrPromise };
  } finally {
    clearTimeout(timeout);
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("ocx start single-proxy invariant", () => {
  test("rejects a healthy configured-port proxy when pid and runtime metadata are absent", async () => {
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/healthz") {
          return Response.json({ service: "opencodex", status: "ok", version: "test", uptime: 1 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const home = mkdtempSync(join(tmpdir(), "ocx-start-single-proxy-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-start-single-proxy-codex-"));
    homes.push(home, codexHome);
    const configPath = join(home, "config.json");
    const configText = JSON.stringify({
      port: proxy.port,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          allowPrivateNetwork: true,
        },
      },
    });
    writeFileSync(configPath, configText, "utf8");
    const injectedConfig = 'model_provider = "opencodex"\n';
    const injectedProfile = 'model = "fixture"\n';
    writeFileSync(join(codexHome, "config.toml"), injectedConfig, "utf8");
    writeFileSync(join(codexHome, "opencodex.config.toml"), injectedProfile, "utf8");
    writeFileSync(join(codexHome, "opencodex-journal.json"), JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model_provider = "openai"\n').toString("base64"),
      originalProfile: null,
      injectedConfigHash: sha256(injectedConfig),
      injectedProfileHash: sha256(injectedProfile),
      pid: 999999,
      timestamp: "2026-01-01T00:00:00.000Z",
    }), "utf8");
    const shimPath = join(codexHome, process.platform === "win32" ? "codex.cmd" : "codex");
    const shimBackupPath = join(codexHome, process.platform === "win32" ? "codex.opencodex-real.cmd" : "codex.opencodex-real");
    const replacementShim = process.platform === "win32"
      ? "@echo off\r\necho externally replaced codex\r\n"
      : "#!/bin/sh\necho externally replaced codex\n";
    const priorShimBackup = process.platform === "win32"
      ? "@echo off\r\necho prior codex\r\n"
      : "#!/bin/sh\necho prior codex\n";
    writeFileSync(shimPath, replacementShim, "utf8");
    writeFileSync(shimBackupPath, priorShimBackup, "utf8");
    if (process.platform !== "win32") {
      chmodSync(shimPath, 0o755);
      chmodSync(shimBackupPath, 0o755);
    }
    writeFileSync(join(home, "codex-shim.json"), `${JSON.stringify({
      platform: process.platform,
      wrapperPath: shimPath,
      originalPath: shimPath,
      backupPath: shimBackupPath,
      wrappers: [{ wrapperPath: shimPath, originalPath: shimPath, backupPath: shimBackupPath }],
    }, null, 2)}\n`, "utf8");
    const opencodexBefore = directorySnapshot(home);
    const codexBefore = directorySnapshot(codexHome);

    try {
      const { status, stdout, stderr } = await runStart(home, codexHome);

      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Proxy already running (PID unknown, port ${proxy.port})`);
      expect(await (await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).json()).toMatchObject({
        service: "opencodex",
      });
      expect(directorySnapshot(home)).toEqual(opencodexBefore);
      expect(directorySnapshot(codexHome)).toEqual(codexBefore);
      expect(readFileSync(shimPath, "utf8")).toBe(replacementShim);
      expect(readFileSync(shimBackupPath, "utf8")).toBe(priorShimBackup);
    } finally {
      proxy.stop(true);
    }
  }, { timeout: 30_000 });

  test("probes the preferred listener before fallback when runtime state is stale", async () => {
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/healthz") {
          return Response.json({ service: "opencodex", status: "ok", version: "test", uptime: 1 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const home = mkdtempSync(join(tmpdir(), "ocx-start-preferred-probe-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-start-preferred-probe-codex-"));
    homes.push(home, codexHome);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: proxy.port,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          allowPrivateNetwork: true,
        },
      },
    }), "utf8");
    writeFileSync(join(home, "ocx.pid"), "999999\n", "utf8");
    writeFileSync(join(home, "runtime-port.json"), JSON.stringify({
      pid: 999999,
      port: 60875,
      hostname: "127.0.0.1",
    }), "utf8");
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
    const opencodexBefore = directorySnapshot(home);

    try {
      const { status, stdout, stderr } = await runStart(home, codexHome, { preload: preferredProbePreloadPath });

      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Proxy already running (PID unknown, port ${proxy.port})`);
      expect(stderr).not.toContain("unexpected duplicate startServer invocation");
      expect(directorySnapshot(home)).toEqual(opencodexBefore);
      expect(await (await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).json()).toMatchObject({
        service: "opencodex",
      });
    } finally {
      proxy.stop(true);
    }
  }, { timeout: 30_000 });

  test("rejects OCX that appears while a soft start is choosing a fallback", async () => {
    let healthRequests = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== "/healthz") return new Response("not found", { status: 404 });
        healthRequests++;
        if (healthRequests === 1) return Response.json({ status: "foreign" });
        return Response.json({ service: "opencodex", status: "ok", version: "test", uptime: 1 });
      },
    });
    const home = mkdtempSync(join(tmpdir(), "ocx-start-fallback-race-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-start-fallback-race-codex-"));
    homes.push(home, codexHome);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: proxy.port,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          allowPrivateNetwork: true,
        },
      },
    }), "utf8");
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
    const opencodexBefore = directorySnapshot(home);
    const codexBefore = directorySnapshot(codexHome);

    try {
      const { status, stdout, stderr } = await runStart(home, codexHome);

      expect(status).toBe(1);
      expect(healthRequests).toBeGreaterThanOrEqual(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(`Proxy already running (PID unknown, port ${proxy.port})`);
      expect(directorySnapshot(home)).toEqual(opencodexBefore);
      expect(directorySnapshot(codexHome)).toEqual(codexBefore);
    } finally {
      proxy.stop(true);
    }
  }, { timeout: 30_000 });

  test("rejects OCX discovered after a soft start loses the bind race", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const preferredPort = probe.port;
    probe.stop(true);
    const home = mkdtempSync(join(tmpdir(), "ocx-start-bind-race-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-start-bind-race-codex-"));
    homes.push(home, codexHome);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: preferredPort,
      hostname: "127.0.0.1",
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          allowPrivateNetwork: true,
        },
      },
    }), "utf8");
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
    const opencodexBefore = directorySnapshot(home);
    const codexBefore = directorySnapshot(codexHome);

    const { status, stdout, stderr } = await runStart(home, codexHome, {
      preload: bindRacePreloadPath,
      env: { OCX_TEST_RACE_PORT: String(preferredPort) },
    });

    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(`Proxy already running (PID unknown, port ${preferredPort})`);
    expect(stdout).not.toContain("picking another");
    expect(directorySnapshot(home)).toEqual(opencodexBefore);
    expect(directorySnapshot(codexHome)).toEqual(codexBefore);
  }, { timeout: 30_000 });
});
