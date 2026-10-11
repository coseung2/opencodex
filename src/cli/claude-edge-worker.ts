import { constants, lstatSync, openSync, fstatSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { atomicWriteFile } from "../config";
import { createFirstPartyEdgeDispatcher, type FirstPartyEdgeBoundCatalog } from "../claude/first-party-edge";
import { parseFirstPartyCatalog } from "../claude/first-party-catalog";
import { pickerPresentationModels } from "../claude/picker-presentation";
import { claudeCliCatalogKind, claudeCliCatalogEligible } from "../claude/cli-catalog";
import { ensureLocalInterceptCaForStartup, issueLocalInterceptLeaf, claudeInterceptCaCertPath } from "../claude/intercept/local-ca";
import { ensureClaudeInterceptProxyToken } from "../claude/intercept/proxy-auth";
import { startConnectProxy } from "../claude/intercept/connect-proxy";
import { startClaudeInterceptListener, proxyFreeFetch } from "../claude/intercept/listener";
import { createTunnelAdmission } from "../claude/intercept/tunnel-admission";
import { buildClaudeInterceptEnv, applyClaudeInterceptSettings, captureClaudeInterceptSettingsRollback, inspectClaudeInterceptSettings, removeClaudeInterceptSettings } from "../claude/intercept/settings";
import { claudeConfigDir } from "../claude/auth-detect";
import { releaseDesktopGateway } from "../claude/desktop-gateway-release";
import { loadConfig } from "../config";
import { ensurePickerAuthority, PICKER_CA_NAME } from "../claude/intercept/picker-authority";
import { inspectPickerTrust, trustPickerCa, untrustPickerCa, pickerDerFingerprint, type PickerTrustOptions } from "../claude/intercept/picker-trust";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { createPickerRelay } from "../claude/intercept/picker-relay";
import { issueServerLeaf } from "../claude/intercept/local-ca";
import { applyPickerProfile, removePickerProfile } from "../claude/intercept/picker-profile";

interface EdgeState { schemaVersion: 1; desired: boolean; connected: boolean; bindingId: string | null; catalog: unknown }
function readState(path: string): EdgeState | null {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 2n * 1024n * 1024n) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) return null;
    const value = JSON.parse(readFileSync(fd, "utf8")) as EdgeState;
    if (value.schemaVersion !== 1 || typeof value.desired !== "boolean" || typeof value.connected !== "boolean"
      || (value.bindingId !== null && (typeof value.bindingId !== "string" || !/^[a-f0-9]{64}$/.test(value.bindingId)))) return null;
    return value;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Bootstrap admission is also needed by Desktop's child CLI for in-session set_model. */
export function claudeEdgeCatalogModels(request: Request, value: EdgeState | null, cliFirstParty: boolean, now = Date.now()) {
  const kind = claudeCliCatalogKind(request.method, new URL(request.url).pathname);
  if (!kind || !claudeCliCatalogEligible(request) || kind !== "bootstrap" && !cliFirstParty) return [];
  if (!value?.desired || !value.connected || !value.bindingId) return [];
  try {
    const catalog = parseFirstPartyCatalog(value.catalog, now);
    return catalog.expiresAt > now ? pickerPresentationModels(catalog.models) : [];
  } catch { return []; }
}

/** Dedicated Notch worker: no provider pool, proxy service, GUI, or Codex injection is started. */
export async function runClaudeEdgeWorker(args: readonly string[]): Promise<number> {
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const configDir = option("--config-dir"), statePath = option("--state");
  const pickerAction = args.some(arg => ["--prepare-picker", "--trust-picker", "--untrust-picker"].includes(arg));
  if (!configDir || !isAbsolute(configDir) || (!pickerAction && !args.includes("--remove") && (!statePath || !isAbsolute(statePath)))) return 1;
  const stage = (value: string) => atomicWriteFile(join(configDir, "startup-stage.json"), JSON.stringify({ pid: process.pid, stage: value }));
  stage("starting");
  const trustOptions = (): PickerTrustOptions => ({
    platform: process.platform,
    windowsDirectory: dirname(dirname(dirname(dirname(resolveTrustedWindowsPowerShellExe())))),
    run: async (executable, argv) => {
      const child = Bun.spawn([executable, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, stdout, stderr: "" };
    },
  });
  if (pickerAction) {
    if (args.includes("--untrust-picker")) await removePickerProfile(configDir);
    const ca = ensurePickerAuthority(configDir, args.includes("--untrust-picker"));
    if (args.includes("--trust-picker")) {
      const result = await trustPickerCa(ca.certPem, { ...trustOptions(), userAction: true });
      if (!result.ok) return 1;
    } else if (args.includes("--untrust-picker")) {
      const result = await untrustPickerCa(ca.certPem, { ...trustOptions(), userAction: true });
      if (!result.ok) return 1;
    }
    console.log(JSON.stringify({ fingerprint: pickerDerFingerprint(ca.certPem), trust: await inspectPickerTrust(ca.certPem, trustOptions()), certificate: join(configDir, "picker-ca.pem") }));
    return 0;
  }
  if (args.includes("--remove")) {
    await removePickerProfile(configDir);
    const removed = removeClaudeInterceptSettings(claudeInterceptCaCertPath(configDir), claudeConfigDir(process.env));
    return removed.ok ? 0 : 1;
  }
  const stateFile = statePath!;
  stage("waiting_for_local_authorization");
  if (realpathSync(stateFile) !== stateFile && process.platform !== "win32") return 1;
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let input = "";
  const initial = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { stdin.off("data", onData); reject(new Error("edge_auth_timeout")); }, 10000);
    const onData = (chunk: string) => {
      input += chunk;
      if (input.length > 4096) { clearTimeout(timer); stdin.off("data", onData); reject(new Error("edge_auth_invalid")); }
      const end = input.indexOf("\n");
      if (end >= 0) { clearTimeout(timer); stdin.off("data", onData); const line = input.slice(0, end); input = input.slice(end + 1); resolve(line); }
    };
    stdin.on("data", onData);
  }).catch(() => "");
  let relayToken: string;
  try {
    const value = JSON.parse(initial);
    if (value.schemaVersion !== 1 || typeof value.relayToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.relayToken)) { stage("invalid_local_authorization"); return 1; }
    relayToken = value.relayToken;
  } catch { stage("local_authorization_unavailable"); return 1; }
  stage("preparing_local_authority");
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const proxyToken = ensureClaudeInterceptProxyToken(configDir);
  const admission = createTunnelAdmission();
  let retained: FirstPartyEdgeBoundCatalog | null = null;
  const state = () => readState(stateFile);
  const dispatch = createFirstPartyEdgeDispatcher({
    relayOrigin: option("--relay-origin") ?? "http://127.0.0.1:10101",
    webSearchHelperModel: "gpt-6-luna",
    backgroundHelperModel: "gpt-6-luna",
    connection: () => { const value = state(); return { connected: value?.connected === true && value.desired, bindingId: value?.bindingId ?? null }; },
    readSnapshot: () => {
      const value = state();
      if (value?.catalog && value.bindingId) {
        try { retained = { bindingId: value.bindingId, snapshot: parseFirstPartyCatalog(value.catalog) }; } catch { /* Retain the last bound policy, never invent routes. */ }
      }
      return retained;
    },
    relay: async request => {
      const headers = new Headers(request.headers); headers.set("X-OCX-Claude-Edge", relayToken);
      // The dispatcher already bounded/read the body. Send a finite upload rather
      // than chunked stream framing through the HTTP/1.1 relay.
      const bytes = new Uint8Array(await request.arrayBuffer());
      headers.delete("transfer-encoding"); headers.delete("expect");
      headers.set("content-length", String(bytes.byteLength));
      return proxyFreeFetch(request.url, { method: request.method, headers, body: bytes, signal: request.signal });
    },
    native: request => proxyFreeFetch(request.url, { method: request.method, headers: request.headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, signal: request.signal }),
  });
  const listener = startClaudeInterceptListener({
    leaf: issueLocalInterceptLeaf(ca, ["api.anthropic.com"]),
    authorize: (req, server) => admission.accepts(server.requestIP(req)),
    dispatch: req => dispatch(req),
    cliCatalogModels: request => claudeEdgeCatalogModels(request, state(), loadConfig().claudeCode?.cliFirstParty === true),
  });
  const portOption = option("--proxy-port");
  const proxyPort = portOption === undefined ? 10200 : Number(portOption);
  if (!Number.isInteger(proxyPort) || proxyPort < 0 || proxyPort > 65535) { await listener.stop(true); return 1; }
  const proxy = await startConnectProxy(proxyPort, { interceptPort: listener.port!, authToken: proxyToken, admitInterceptSocket: admission.register });
  let picker: { close(): Promise<void> } | null = null;
  const pickerRequested = args.includes("--apply-picker") || !!readState(stateFile)?.desired && !!readFileSafe(join(configDir, "picker-profile.json"));
  const pickerStatus: { ready: boolean; rewritten: number; reason: string } = { ready: false, rewritten: 0, reason: "off" };
  const writeStatus = () => atomicWriteFile(join(configDir, "status.json"), JSON.stringify({ schemaVersion: 1, pid: process.pid, ready: true, proxyPort: proxy.port, mode: "first-party", settings, picker: pickerStatus }));
  if (pickerRequested) {
    try {
      const ca = ensurePickerAuthority(configDir);
      if (await inspectPickerTrust(ca.certPem, trustOptions()) !== "trusted") throw new Error("picker_trust_required");
      const admission = createTunnelAdmission();
      const dispatch = createPickerRelay({
        models: () => {
          const value = state();
          if (!value?.desired || !value.connected || !value.bindingId) return [];
          try { const catalog = parseFirstPartyCatalog(value.catalog); return catalog.expiresAt > Date.now() ? pickerPresentationModels(catalog.models) : []; } catch { return []; }
        },
        outcome: result => { if (result.kind === "rewritten") pickerStatus.rewritten += result.added; pickerStatus.reason = result.kind === "rewritten" ? "rewritten" : result.reason; writeStatus(); },
      });
      const leaf = issueServerLeaf(ca, PICKER_CA_NAME, ["claude.ai"]);
      const tls = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: leaf.certPem, key: leaf.keyPem }, idleTimeout: 255,
        fetch: (request, server) => admission.accepts(server.requestIP(request)) ? dispatch(request) : new Response(null, { status: 403 }),
      });
      let connectProxy: Awaited<ReturnType<typeof startConnectProxy>> | undefined;
      let pac: ReturnType<typeof Bun.serve> | undefined;
      try {
        connectProxy = await startConnectProxy(10201, { interceptPort: tls.port!, allowedTargets: ["claude.ai:443"], interceptHosts: ["claude.ai"], admitInterceptSocket: admission.register });
        const script = 'function FindProxyForURL(url, host) { return host === "claude.ai" ? "PROXY 127.0.0.1:10201" : "DIRECT"; }';
        pac = Bun.serve({ hostname: "127.0.0.1", port: 10202, fetch: request => request.method === "GET" && new URL(request.url).pathname === "/ocx-claude-picker.pac"
          ? new Response(script, { headers: { "content-type": "application/x-ns-proxy-autoconfig", "cache-control": "no-store" } }) : new Response(null, { status: 404 }) });
        picker = { async close() { await pac?.stop(true); await connectProxy?.close(); await tls.stop(true); } };
        pickerStatus.ready = true; pickerStatus.reason = "waiting_for_app_restart";
      } catch (error) { await pac?.stop(true); await connectProxy?.close(); await tls.stop(true); throw error; }
    } catch {
      try { await removePickerProfile(configDir); pickerStatus.reason = "picker_setup_unavailable_profile_restored"; }
      catch { pickerStatus.reason = "picker_setup_unavailable_profile_changed"; }
      if (args.includes("--apply-picker")) { await proxy.close(); await listener.stop(true); return 1; }
    }
  }
  const env = buildClaudeInterceptEnv(proxy.port, claudeInterceptCaCertPath(configDir), proxyToken);
  stage("inspecting_owned_settings");
  let settings = inspectClaudeInterceptSettings(env, claudeConfigDir(process.env)).kind;
  if (settings !== "applied" && !args.includes("--apply")) {
    await picker?.close(); await proxy.close(); await listener.stop(true); return 1;
  }
  if (args.includes("--apply")) {
    stage("applying_owned_settings");
    const rollback = captureClaudeInterceptSettingsRollback(env, claudeConfigDir(process.env));
    const applied = applyClaudeInterceptSettings(env, claudeConfigDir(process.env));
    if (applied.ok) {
      const released = releaseDesktopGateway({ appliedFingerprint: loadConfig().claudeCode?.desktopProfile?.appliedFingerprint, expectedGatewayOrigin: "http://127.0.0.1:10101" });
      if (!released.ok) { stage(`gateway_release_${released.reason}`); if (applied.changed) rollback(); await picker?.close(); await proxy.close(); await listener.stop(true); return 1; }
      if (args.includes("--apply-picker")) {
        try { await applyPickerProfile(configDir, "http://127.0.0.1:10202/ocx-claude-picker.pac"); }
        catch { released.rollback(); if (applied.changed) rollback(); await picker?.close(); await proxy.close(); await listener.stop(true); return 1; }
      }
      settings = "applied";
    } else { stage(`settings_${applied.reason}`); await picker?.close(); await proxy.close(); await listener.stop(true); return 1; }
  }
  stage("ready");
  writeStatus();
  return await new Promise<number>(resolve => {
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; await picker?.close(); await proxy.close(); await listener.stop(true); resolve(0); };
    stdin.on("end", () => { void stop(); });
    stdin.on("data", (chunk: string) => { input += chunk; if (input.length > 4096 || input.includes('"shutdown"')) void stop(); });
    process.once("SIGTERM", () => { void stop(); });
  });
}

function readFileSafe(path: string): string | null {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024 ? readFileSync(path, "utf8") : null; } catch { return null; }
}
