import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config";
import { claudeFirstPartyConfigError } from "../desktop-mode";
import { firstPartyDesired } from "../first-party-settings";
import { buildClaudeInterceptEnv, type ClaudeInterceptEnv } from "./settings";
import { claudeInterceptCaCertPath, ensureLocalInterceptCaForStartup, issueLocalInterceptLeaf } from "./local-ca";
import { ensureClaudeInterceptProxyToken, readClaudeInterceptProxyToken } from "./proxy-auth";
import { startConnectProxy, type ConnectProxyHandle } from "./connect-proxy";
import { relayToUpstream, CLAUDE_INTERCEPT_UPSTREAM, startClaudeInterceptListener } from "./listener";
import { configuredApiAuthToken, isApiAuthRequired } from "../../server/auth-cors";
import { readJsonRequestBody } from "../../server/request-decompress";
import { isFirstPartySecurityClassifier } from "../first-party-edge";
import { createTunnelAdmission } from "./tunnel-admission";

export const CLAUDE_INTERCEPT_PORT_OFFSET = 100;
export function claudeInterceptProxyPort(config: Pick<OcxConfig, "claudeCode">, publicPort: number): number {
  const port = config.claudeCode?.intercept?.port ?? publicPort + CLAUDE_INTERCEPT_PORT_OFFSET;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_intercept_port");
  return port;
}
export function claudeInterceptEnabled(config: Pick<OcxConfig, "claudeCode">): boolean {
  return !claudeFirstPartyConfigError(config) && config.claudeCode?.enabled !== false && config.claudeCode?.intercept?.enabled !== false;
}
export interface ClaudeInterceptState { proxyPort: number; caCertPath: string }
export interface ClaudeInterceptHandle extends ClaudeInterceptState { stop(): Promise<void> }
export interface StartClaudeInterceptOptions<T> {
  config: OcxConfig;
  publicPort: number;
  configDir?: string;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  maxRequestBodySize?: number;
}
let active: ClaudeInterceptHandle | null = null;
let startFlight: Promise<ClaudeInterceptHandle> | null = null;
let registered: StartClaudeInterceptOptions<unknown> | null = null;

/** Installation registration is separate from startup; default gateway never mints a CA. */
export function registerClaudeIntercept<T>(options: StartClaudeInterceptOptions<T>): void {
  registered = options as unknown as StartClaudeInterceptOptions<unknown>;
}
export function getClaudeInterceptState(): ClaudeInterceptState | null {
  return active ? { proxyPort: active.proxyPort, caCertPath: active.caCertPath } : null;
}
export function configuredClaudeInterceptEnv(config: OcxConfig, publicPort: number, configDir = getConfigDir()): ClaudeInterceptEnv | null {
  const token = readClaudeInterceptProxyToken(configDir);
  return token ? buildClaudeInterceptEnv(claudeInterceptProxyPort(config, publicPort), claudeInterceptCaCertPath(configDir), token) : null;
}

async function start<T>(options: StartClaudeInterceptOptions<T>): Promise<ClaudeInterceptHandle> {
  if (!claudeInterceptEnabled(options.config)) throw new Error("intercept_disabled");
  const configDir = options.configDir ?? getConfigDir();
  const proxyPort = claudeInterceptProxyPort(options.config, options.publicPort);
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const token = ensureClaudeInterceptProxyToken(configDir);
  const admission = createTunnelAdmission();
  const listener = startClaudeInterceptListener<T>({
    leaf: issueLocalInterceptLeaf(ca, ["api.anthropic.com"]),
    authorize: (req, server) => admission.accepts(server.requestIP(req)),
    dispatch: async (req, requestServer) => {
      // Native classifier stays native even when the user's ordinary Claude slot is mapped.
      const body = await readJsonRequestBody(req.clone()).catch(() => null);
      if (isFirstPartySecurityClassifier(body)) {
        return relayToUpstream(req, CLAUDE_INTERCEPT_UPSTREAM);
      }
      if (!isApiAuthRequired(options.config)) return options.dispatch(req, requestServer);
      const admission = options.config.apiKeys?.[0]?.key ?? configuredApiAuthToken(options.config);
      if (!admission) return Response.json({ type: "error", error: { type: "authentication_error", message: "Local OCX data admission unavailable" } }, { status: 503 });
      const headers = new Headers(req.headers);
      headers.set("x-opencodex-api-key", admission);
      return options.dispatch(new Request(req, { headers }), requestServer);
    },
    maxRequestBodySize: options.maxRequestBodySize,
  });
  let proxy: ConnectProxyHandle;
  try {
    proxy = await startConnectProxy(proxyPort, { interceptPort: listener.port!, authToken: token, admitInterceptSocket: admission.register });
  } catch { await listener.stop(true); throw new Error("intercept_port_unavailable"); }
  const handle: ClaudeInterceptHandle = {
    proxyPort: proxy.port, caCertPath: claudeInterceptCaCertPath(configDir),
    async stop() {
      try { await proxy.close(); } finally { await listener.stop(true); }
      if (active === handle) active = null;
    },
  };
  return handle;
}

export async function ensureClaudeInterceptStarted(): Promise<ClaudeInterceptHandle> {
  if (active) return active;
  if (!registered) throw new Error("intercept_server_unavailable");
  if (startFlight) return startFlight;
  const options = registered;
  startFlight = start(options).then(handle => { active = handle; return handle; });
  try { return await startFlight; } finally { startFlight = null; }
}
export async function startDesiredClaudeIntercept(): Promise<void> {
  if (!registered) return;
  const desired = firstPartyDesired(registered.config);
  if (desired.desktop || desired.cli) await ensureClaudeInterceptStarted();
}
export async function prepareClaudeFirstParty(): Promise<{ env: ClaudeInterceptEnv; proxyPort: number }> {
  const handle = await ensureClaudeInterceptStarted();
  const configDir = registered?.configDir ?? getConfigDir();
  const token = readClaudeInterceptProxyToken(configDir);
  if (!token) throw new Error("intercept_credential_unavailable");
  return { env: buildClaudeInterceptEnv(handle.proxyPort, handle.caCertPath, token), proxyPort: handle.proxyPort };
}
export async function stopClaudeIntercept(): Promise<void> {
  registered = null;
  const pending = startFlight;
  if (pending) { try { await pending; } catch { /* Failed startup has no live pair. */ } }
  await active?.stop();
}
