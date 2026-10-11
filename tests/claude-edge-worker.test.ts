import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import tls from "node:tls";
import { buildFirstPartyCatalog } from "../src/claude/first-party-catalog";

test("Notch dedicated worker applies fixture settings and routes through authenticated tunnel", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-edge-worker-"));
  const configDir = join(root, "edge"), claudeDir = join(root, "claude"), library = join(root, "desktop");
  mkdirSync(configDir); mkdirSync(claudeDir); mkdirSync(library);
  const catalog = buildFirstPartyCatalog([{ provider: "fixture", id: "worker" }]);
  const state = join(configDir, "state.json");
  writeFileSync(state, JSON.stringify({ schemaVersion: 1, desired: true, connected: true, bindingId: "a".repeat(64), catalog }));
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ unrelated: true }));
  let relayCalls = 0;
  const relay = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    expect(req.headers.get("x-ocx-claude-edge")).toBe("b".repeat(43));
    expect(req.headers.get("authorization")).toBeNull();
    relayCalls++;
    return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "fixture OK" }] }), { headers: { "content-type": "application/json" } });
  } });
  const safeEnv = Object.fromEntries(["SystemRoot", "WINDIR", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "USERNAME", "USERDOMAIN", "HOME", "TEMP", "TMP", "PATH", "PATHEXT"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const child = Bun.spawn([process.execPath, "--no-env-file", resolve("src/cli/claude-edge-entry.ts"), "--config-dir", configDir, "--state", state, "--apply", "--proxy-port", "0", "--relay-origin", `http://127.0.0.1:${relay.port}`], {
    env: { ...safeEnv, OPENCODEX_HOME: join(root, "ocx"), CLAUDE_CONFIG_DIR: claudeDir, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: library },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ schemaVersion: 1, relayToken: "b".repeat(43) }) + "\n");
  try {
    const deadline = Date.now() + 30000;
    while (!existsSync(join(configDir, "status.json")) && Date.now() < deadline) await Bun.sleep(100);
    expect(existsSync(join(configDir, "status.json"))).toBe(true);
    const status = JSON.parse(readFileSync(join(configDir, "status.json"), "utf8"));
    expect(status.settings).toBe("applied");
    const env = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")).env;
    const proxy = new URL(env.HTTPS_PROXY);
    const response = await new Promise<string>((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error(`TLS fixture timeout; relayCalls=${relayCalls}`)), 10000);
      const socket = connect({ host: "127.0.0.1", port: status.proxyPort }, () => socket.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`opencodex:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n\r\n`));
      socket.once("data", () => {
        const secure = tls.connect({ socket, servername: "api.anthropic.com", ca: readFileSync(env.NODE_EXTRA_CA_CERTS) }, () => {
          const payload = JSON.stringify({ model: catalog.models[0]!.id, messages: [{ role: "user", content: "fixture" }] });
          secure.write(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nAuthorization: Bearer fixture-anthropic-token\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
        });
        let received = "";
        secure.on("data", chunk => {
          received += chunk.toString();
          if (received.includes("fixture OK")) { clearTimeout(timer); secure.destroy(); resolveReply(received); }
        });
        secure.on("end", () => { clearTimeout(timer); resolveReply(received); }); secure.on("error", error => { clearTimeout(timer); reject(error); });
        secure.on("close", () => { clearTimeout(timer); resolveReply(received); });
      });
      socket.on("error", reject);
    });
    expect(response).toContain("fixture OK"); expect(relayCalls).toBe(1);
  } finally {
    child.stdin.write('{"command":"shutdown"}\n'); child.stdin.end();
    await Promise.race([child.exited, Bun.sleep(5000).then(() => { child.kill(); return child.exited; })]);
    await relay.stop(true); rmSync(root, { recursive: true, force: true });
  }
}, 45000);
