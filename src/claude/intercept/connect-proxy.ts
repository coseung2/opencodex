import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, createServer, connect, isIP, type Server, type Socket } from "node:net";

/**
 * Loopback HTTP CONNECT proxy for Claude Code.
 *
 * Claude Code honours `HTTPS_PROXY` and opens `CONNECT <host>:443` for every upstream. This
 * proxy splices tunnels for the intercepted hosts onto the local TLS listener (which holds a
 * leaf certificate for them) and blindly relays every other tunnel to its real destination,
 * so telemetry and OAuth refresh stay native and opaque to opencodex. Picker mode may
 * terminate only claude.ai tunnels, selected independently for each connection.
 *
 * CONNECT is the only general form served. The single exception is a narrow, authenticated
 * absolute-form forward of the Claude Code environment bridge
 * (`https://api.anthropic.com/v1/environments/bridge`): that control-plane path is not
 * inference, is never dispatched to the router, and is relayed straight to Anthropic. Every
 * other plain proxied request is refused, so this socket can never become an open HTTP proxy.
 */

export const CLAUDE_INTERCEPT_HOSTS = ["api.anthropic.com"] as const;

/** Exact origin the absolute-form reconciliation path may reach; nothing else is forwardable. */
export const CLAUDE_BRIDGE_HOST = "api.anthropic.com";
/** Exact path (query allowed) of the native, non-inference bridge forward. */
export const CLAUDE_BRIDGE_PATH = "/v1/environments/bridge";

const MAX_HEAD_BYTES = 8 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** Bounded buffered body for the single absolute-form target; the bridge sends small JSON. */
const MAX_ABSOLUTE_BODY_BYTES = 2 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
const ABSOLUTE_METHODS = new Set(["GET", "POST"]);

export interface ConnectProxyOptions {
  /** Loopback port of the TLS listener that terminates intercepted tunnels. */
  interceptPort: number;
  /**
   * Per-install bearer carried as HTTP Basic proxy credentials. Omit only for listeners whose
   * clients cannot present proxy credentials at all; an unauthenticated CONNECT proxy stays an
   * open loopback relay, so every consumer that can carry the credential must set this.
   *
   * The narrow absolute-form bridge forward is only reachable when this is set: an
   * unauthenticated listener refuses it outright rather than becoming a plaintext forward proxy.
   */
  authToken?: string | (() => string | null);
  /** Hostnames (lowercase) whose 443 tunnels are spliced onto `interceptPort`. */
  interceptHosts?: readonly string[];
  /** Optional exact CONNECT authorities (host:port); empty denies all, absent keeps blind relay. */
  allowedTargets?: readonly string[];
  /** Per-connection override, consulted before interceptHosts; null keeps the default. */
  selectTunnel?: (host: string, port: number, request: ConnectRequestInfo) => TunnelDecision | null | Promise<TunnelDecision | null>;
  /** Test seam: dial the real destination for a blind tunnel. */
  dialUpstream?: (host: string, port: number) => Socket;
  /** Test seam: perform the narrow absolute-form TLS forward (defaults to `forwardAbsoluteOverTls`). */
  forwardAbsolute?: AbsoluteForwarder;
  /** Register an authenticated proxy-to-listener socket before releasing client TLS bytes. */
  admitInterceptSocket?: (socket: Socket) => void;
}

export type TunnelDecision = { kind: "intercept"; port: number } | { kind: "blind" };

/** What the CONNECT head says about its client, for tunnel choice only. Never logged. */
export interface ConnectRequestInfo {
  /** The CONNECT request's User-Agent header, or null when it sent none. */
  userAgent: string | null;
}

/** Parsed absolute-form target, after scheme/method/target normalization. */
export interface AbsoluteFormTarget {
  method: string;
  url: URL;
  /** Lowercase host with any trailing root dot stripped. */
  host: string;
  port: number;
  /** Origin-form path plus query, ready for the upstream request line. */
  path: string;
}

/** A validated, sanitized request handed to the absolute-form forwarder. */
export interface AbsoluteForwardRequest {
  method: string;
  host: string;
  port: number;
  path: string;
  /** Hop-by-hop and proxy headers already stripped; `host` already set to the target. */
  headers: Headers;
  body: Uint8Array | null;
}

/** Proxy-free upstream response, streamed back as chunked plaintext to the client. */
export interface AbsoluteForwardResult {
  status: number;
  statusText: string;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
}

export type AbsoluteForwarder = (request: AbsoluteForwardRequest) => Promise<AbsoluteForwardResult> | AbsoluteForwardResult;

/**
 * Chromium (Claude Desktop's app) sends its browser User-Agent on CONNECT; the Claude Code
 * processes Desktop spawns send none. The two trust different CAs, so the tunnel choice uses it.
 *
 * This is a routing hint, not a trust boundary: a local client can send any User-Agent. Neither
 * answer grants anything a local process lacks already. A non-browser tunnel reaches the
 * api.anthropic.com intercept, which the Claude Code proxy offers every local process; a browser
 * tunnel reaches the claude.ai relay, which verifies upstream and injects no credential. A client
 * that lies only breaks its own TLS, because each terminator presents a certificate only its
 * intended client trusts.
 */
export function isBrowserConnect(request: ConnectRequestInfo): boolean {
  return request.userAgent !== null && /^Mozilla\//.test(request.userAgent);
}

function connectRequestInfo(head: string): ConnectRequestInfo {
  const match = /\r\nuser-agent:[ \t]*([^\r\n]*)/i.exec(head);
  return { userAgent: match ? match[1]!.trim() : null };
}

type ResolvedConnectProxyOptions = Required<Pick<ConnectProxyOptions, "interceptPort" | "interceptHosts" | "dialUpstream" | "forwardAbsolute">>
  & Pick<ConnectProxyOptions, "selectTunnel" | "authToken" | "admitInterceptSocket">
  & { allowedTargets?: ReadonlySet<string> };

export interface ConnectProxyHandle {
  port: number;
  close(): Promise<void>;
}

interface ConnectTarget {
  host: string;
  port: number;
}

/** Parse `CONNECT host:port HTTP/1.1` from a request head; `null` for anything else. */
export function parseConnectRequestLine(head: string): ConnectTarget | null {
  const requestLine = head.split("\r\n", 1)[0] ?? "";
  const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/.exec(requestLine);
  if (!match) return null;
  const authority = match[1]!;
  // Bracketed IPv6 (`[::1]:443`) and plain `host:port`.
  const ipv6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(authority);
  const hostPort = ipv6 ?? /^([^:]+):(\d{1,5})$/.exec(authority);
  if (!hostPort) return null;
  const port = Number(hostPort[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: hostPort[1]!.toLowerCase().replace(/\.$/, ""), port };
}

/**
 * Parse an absolute-form proxy request line (`GET https://host/path HTTP/1.1`).
 *
 * Only `https://` targets on the allowlisted bridge authority are ever returned; every other
 * shape — `http://` targets, origin-form requests, explicit non-443 ports, userinfo, fragments —
 * yields `null` so the caller refuses with 405 rather than relaying. This is the whole reason the
 * socket cannot become a general forward proxy.
 */
export function parseAbsoluteFormRequestLine(requestLine: string): AbsoluteFormTarget | null {
  const match = /^([A-Z]+) +(https:\/\/\S+) +HTTP\/1\.[01]$/.exec(requestLine);
  if (!match) return null;
  const method = match[1]!;
  if (!ABSOLUTE_METHODS.has(method)) return null;
  let url: URL;
  try {
    url = new URL(match[2]!);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Credentials embedded in the target are never legitimate here and smell like smuggling.
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // An explicit port must be the default 443; a bare authority normalizes to it.
  if (url.port !== "" && url.port !== "443") return null;
  return { method, url, host, port: 443, path: `${url.pathname}${url.search}` };
}

/** True only for the exact native, non-inference bridge path on the allowlisted host. */
export function isAllowedBridgeTarget(target: AbsoluteFormTarget): boolean {
  return target.host === CLAUDE_BRIDGE_HOST && target.url.pathname === CLAUDE_BRIDGE_PATH;
}

// 127/8 and ::1, which `BlockList` also matches in IPv4-mapped form (`::ffff:127.0.0.1`,
// `::ffff:7f00:1`). The unspecified addresses dial the local host too.
const LOCAL_TARGETS = new BlockList();
LOCAL_TARGETS.addSubnet("127.0.0.0", 8, "ipv4");
LOCAL_TARGETS.addAddress("0.0.0.0", "ipv4");
LOCAL_TARGETS.addAddress("::1", "ipv6");
LOCAL_TARGETS.addAddress("::", "ipv6");

export function isLoopbackTarget(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  if (family !== 0) return LOCAL_TARGETS.check(host, family === 6 ? "ipv6" : "ipv4");
  // `127.1`, `0x7f000001`, `2130706433`: resolver shorthand for a loopback literal, not a name.
  return /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(host);
}

function respond(socket: Socket, status: number, reason: string, headers: Readonly<Record<string, string>> = {}): void {
  if (socket.destroyed) return;
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}

function splice(client: Socket, upstream: Socket, pending: Uint8Array): void {
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", teardown);
  upstream.on("error", teardown);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.setTimeout(0);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  if (pending.length > 0) upstream.write(pending);
  client.pipe(upstream);
  upstream.pipe(client);
}

/** Every occurrence of a header name in the decoded head, in order. The request line is skipped. */
function headerValues(head: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (const line of head.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === wanted) values.push(line.slice(colon + 1).trim());
  }
  return values;
}

/** The first forbidden header that appears more than once, or null. */
function firstDuplicatedHeader(head: string, names: readonly string[]): string | null {
  for (const name of names) {
    if (headerValues(head, name).length > 1) return name;
  }
  return null;
}

function proxyAuthorized(head: string, token: string): boolean {
  const values = headerValues(head, "proxy-authorization");
  const supplied = values.length === 1 ? values[0]! : "";
  const expected = `Basic ${Buffer.from(`opencodex:${token}`).toString("base64")}`;
  if (!supplied) return false;
  // Compare byte lengths, not string lengths: the head decodes latin1 and Buffer.from
  // re-encodes utf-8, so a non-ASCII header can match in characters while differing in
  // bytes — and timingSafeEqual throws on a length mismatch instead of returning false.
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

/** Resolve the per-install credential for this connection; absent/unavailable means deny. */
function resolveAuthToken(authToken: string | (() => string | null)): string | null {
  try {
    return typeof authToken === "function" ? authToken() : authToken;
  } catch { // no-excuse-ok: catch -- an unavailable credential must never fall back to an unauthenticated proxy.
    return null;
  }
}

const ABSOLUTE_HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);
const RESPONSE_STRIP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

/** Rebuild the client head into upstream headers, dropping proxy/hop-by-hop and pinning Host. */
function buildAbsoluteForwardHeaders(head: string): Headers {
  const headers = new Headers();
  // Skip the request line: its `https://` colon would otherwise parse as a header name.
  for (const line of head.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (name === "" || ABSOLUTE_HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.append(name, line.slice(colon + 1).trim());
  }
  headers.set("host", CLAUDE_BRIDGE_HOST);
  return headers;
}

/** Fixed-length body size, or null when the framing is ambiguous and must be refused. */
function absoluteBodyLength(head: string): number | null {
  // Chunked framing on top of a proxy hop is a smuggling vector; a Content-Length/Transfer-Encoding
  // pair is ambiguous. Both are refused rather than guessed.
  if (headerValues(head, "transfer-encoding").length > 0) return null;
  const values = headerValues(head, "content-length");
  if (values.length === 0) return 0;
  if (!/^\d+$/.test(values[0]!)) return null;
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length) || length < 0) return null;
  return length;
}

/**
 * Default absolute-form forwarder.
 *
 * Uses `node:https` rather than `fetch` on purpose: Bun's `fetch` consults `HTTPS_PROXY` from the
 * environment and its `proxy: ""` override does not disable that (verified against Bun 1.4.0), so a
 * bridge forward issued with `fetch` would re-enter this very CONNECT proxy and recurse. `node:https`
 * with a private agent does not read proxy environment variables, so the forward lands on Anthropic
 * directly.
 */
export function forwardAbsoluteOverTls(request: AbsoluteForwardRequest): Promise<AbsoluteForwardResult> {
  return new Promise((resolve, reject) => {
    const upstream = httpsRequest({
      host: request.host,
      port: request.port,
      method: request.method,
      path: request.path,
      headers: Object.fromEntries(request.headers.entries()),
      servername: request.host,
      agent: false,
    }, (response: IncomingMessage) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.append(name, value);
      }
      resolve({
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers,
        body: incomingBody(response),
      });
    });
    upstream.on("error", reject);
    if (request.body) upstream.write(request.body);
    upstream.end();
  });
}

function incomingBody(response: IncomingMessage): AsyncIterable<Uint8Array> {
  return (async function* () {
    for await (const chunk of response) yield chunk as Uint8Array;
  })();
}

/** Stream a proxy-free upstream result back over the plaintext client socket, framed chunked. */
async function writeAbsoluteResponse(socket: Socket, method: string, result: AbsoluteForwardResult): Promise<void> {
  if (socket.destroyed) return;
  const statusText = (result.statusText ?? "").replace(/[\r\n]/g, " ");
  let head = `HTTP/1.1 ${result.status} ${statusText}\r\n`;
  result.headers.forEach((value, name) => {
    if (RESPONSE_STRIP_HEADERS.has(name.toLowerCase())) return;
    head += `${name.replace(/[\r\n]/g, "")}: ${String(value).replace(/[\r\n]/g, " ")}\r\n`;
  });
  const bodyless = method === "HEAD" || result.status === 204 || result.status === 304 || result.body === null;
  if (bodyless) {
    socket.write(`${head}connection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.end();
    return;
  }
  socket.write(`${head}connection: close\r\ntransfer-encoding: chunked\r\n\r\n`);
  try {
    for await (const chunk of result.body!) {
      if (socket.destroyed) return;
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayLike<number>);
      if (bytes.length === 0) continue;
      socket.write(`${bytes.length.toString(16)}\r\n`);
      socket.write(bytes);
      socket.write("\r\n");
    }
    if (!socket.destroyed) {
      socket.write("0\r\n\r\n");
      socket.end();
    }
  } catch { // no-excuse-ok: catch -- a failed upstream stream tears down the client socket.
    socket.destroy();
  }
}

function handleConnect(socket: Socket, options: ResolvedConnectProxyOptions, requestHead: string, pending: Buffer, target: ConnectTarget): void {
  if (options.authToken !== undefined) {
    const token = resolveAuthToken(options.authToken);
    if (!token || !proxyAuthorized(requestHead, token)) {
      respond(socket, 407, "Proxy Authentication Required", { "Proxy-Authenticate": 'Basic realm="OpenCodex"' });
      return;
    }
  }
  if (isLoopbackTarget(target.host)) {
    respond(socket, 403, "Forbidden");
    return;
  }
  if (options.allowedTargets && !options.allowedTargets.has(`${target.host}:${target.port}`)) {
    respond(socket, 403, "Forbidden");
    return;
  }
  // Bytes already read past the head, plus anything a paused socket holds before the dial.
  let pendingBytes = pending;
  const dialFor = (selected: TunnelDecision | null): void => {
    if (socket.destroyed) return;
    const choice = selected ?? (target.port === 443 && options.interceptHosts.includes(target.host)
      ? { kind: "intercept" as const, port: options.interceptPort }
      : { kind: "blind" as const });
    const upstream = choice.kind === "intercept"
      ? connect({ host: "127.0.0.1", port: choice.port })
      : options.dialUpstream(target.host, target.port);
    let established = false;
    const connectTimer = setTimeout(() => {
      if (!established) {
        upstream.destroy();
        respond(socket, 504, "Gateway Timeout");
      }
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    upstream.once("error", () => {
      clearTimeout(connectTimer);
      if (!established) respond(socket, 502, "Bad Gateway");
    });
    upstream.once("connect", () => {
      established = true;
      clearTimeout(connectTimer);
      if (socket.destroyed) {
        upstream.destroy();
        return;
      }
      if (choice.kind === "intercept") options.admitInterceptSocket?.(upstream);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      splice(socket, upstream, pendingBytes);
      socket.resume();
    });
  };
  if (!options.selectTunnel) {
    dialFor(null);
    return;
  }
  let decision: ReturnType<NonNullable<ConnectProxyOptions["selectTunnel"]>>;
  try {
    decision = options.selectTunnel(target.host, target.port, connectRequestInfo(requestHead));
  } catch {
    dialFor({ kind: "blind" });
    return;
  }
  if (!decision || typeof (decision as Promise<TunnelDecision | null>).then !== "function") {
    dialFor(decision as TunnelDecision | null);
    return;
  }
  // A paused socket does not notice a peer FIN until its readable side is drained.
  // Hold later tunnel bytes here so a departing client cannot trigger a stale dial.
  const onPendingReadable = () => {
    let chunk: Buffer | null;
    while ((chunk = socket.read() as Buffer | null) !== null) {
      if (pendingBytes.length + chunk.length > MAX_PENDING_BYTES) {
        socket.destroy();
        return;
      }
      pendingBytes = Buffer.concat([pendingBytes, chunk]);
    }
  };
  const onPendingEnd = () => socket.destroy();
  socket.on("readable", onPendingReadable);
  socket.once("end", onPendingEnd);
  void Promise.resolve(decision).catch(() => ({ kind: "blind" as const })).then(choice => {
    socket.off("readable", onPendingReadable);
    socket.off("end", onPendingEnd);
    dialFor(choice);
  });
  return;
}

/** Read the fixed-length absolute-form body from the paused socket, bounded and single-shot. */
function readAbsoluteBody(socket: Socket, pending: Buffer, length: number, done: (body: Buffer | null) => void): void {
  if (pending.length >= length) {
    done(pending.subarray(0, length));
    return;
  }
  const chunks = [pending];
  let have = pending.length;
  let settled = false;
  const finish = (body: Buffer | null) => {
    if (settled) return;
    settled = true;
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    done(body);
  };
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    have += chunk.length;
    if (have >= length) finish(Buffer.concat(chunks).subarray(0, length));
  };
  const onEnd = () => finish(null);
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  socket.resume();
}

function handleAbsoluteForm(socket: Socket, options: ResolvedConnectProxyOptions, requestHead: string, pending: Buffer): void {
  // Absolute-form forwarding exists only for the credential-bearing intercept proxy. Without a
  // configured credential the feature is off entirely, so this port stays a CONNECT-only relay.
  if (options.authToken === undefined) {
    respond(socket, 403, "Forbidden");
    return;
  }
  const requestLine = requestHead.split("\r\n", 1)[0] ?? "";
  const target = parseAbsoluteFormRequestLine(requestLine);
  if (!target) {
    // Origin-form, `http://`, non-443 port, userinfo, fragment, or unsupported method: refuse
    // rather than relay. Only an exact `https://api.anthropic.com` bridge target survives below.
    respond(socket, 405, "Method Not Allowed");
    return;
  }
  if (firstDuplicatedHeader(requestHead, ["proxy-authorization", "host", "content-length"]) !== null) {
    respond(socket, 400, "Bad Request");
    return;
  }
  const token = resolveAuthToken(options.authToken);
  if (!token || !proxyAuthorized(requestHead, token)) {
    respond(socket, 407, "Proxy Authentication Required", { "Proxy-Authenticate": 'Basic realm="OpenCodex"' });
    return;
  }
  // A Host that disagrees with the absolute target is ambiguous and refused, never reconciled.
  const hostHeader = headerValues(requestHead, "host")[0];
  if (hostHeader !== undefined && hostHeader !== CLAUDE_BRIDGE_HOST && hostHeader !== `${CLAUDE_BRIDGE_HOST}:443`) {
    respond(socket, 400, "Bad Request");
    return;
  }
  if (!isAllowedBridgeTarget(target)) {
    respond(socket, 403, "Forbidden");
    return;
  }
  const length = absoluteBodyLength(requestHead);
  if (length === null) {
    respond(socket, 400, "Bad Request");
    return;
  }
  if (length > MAX_ABSOLUTE_BODY_BYTES) {
    respond(socket, 413, "Payload Too Large");
    return;
  }
  readAbsoluteBody(socket, pending, length, body => {
    if (body === null || socket.destroyed) {
      if (!socket.destroyed) respond(socket, 400, "Bad Request");
      return;
    }
    socket.setTimeout(0);
    const request: AbsoluteForwardRequest = {
      method: target.method,
      host: target.host,
      port: target.port,
      path: target.path,
      headers: buildAbsoluteForwardHeaders(requestHead),
      body: body.length > 0 ? body : null,
    };
    void Promise.resolve()
      .then(() => options.forwardAbsolute(request))
      .then(result => writeAbsoluteResponse(socket, target.method, result))
      .catch(() => { if (!socket.destroyed) respond(socket, 502, "Bad Gateway"); });
  });
}

function handleConnection(socket: Socket, options: ResolvedConnectProxyOptions): void {
  let head: Buffer = Buffer.alloc(0);
  socket.on("error", () => socket.destroy());
  socket.setTimeout(HEAD_TIMEOUT_MS, () => respond(socket, 408, "Request Timeout"));

  const onData = (chunk: Buffer) => {
    head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    // The cap holds however the head arrives: across reads or in one oversized read.
    if (end === -1 || end + 4 > MAX_HEAD_BYTES) {
      if (head.length > MAX_HEAD_BYTES) {
        socket.off("data", onData);
        respond(socket, 431, "Request Header Fields Too Large");
      }
      return;
    }
    socket.off("data", onData);
    socket.pause();
    const requestHead = head.subarray(0, end).toString("latin1");
    // Bytes after the head belong to the tunnel (a client may pipeline its TLS ClientHello).
    const pending = head.subarray(end + 4);
    const target = parseConnectRequestLine(requestHead);
    if (target) {
      // Duplicate credentials are ambiguous: refuse before any authentication decision.
      if (firstDuplicatedHeader(requestHead, ["proxy-authorization"]) !== null) {
        respond(socket, 400, "Bad Request");
        return;
      }
      handleConnect(socket, options, requestHead, pending, target);
      return;
    }
    // A duplicate Proxy-Authorization must be refused before the absolute-form auth decision too.
    if (firstDuplicatedHeader(requestHead, ["proxy-authorization"]) !== null) {
      respond(socket, 400, "Bad Request");
      return;
    }
    try {
      handleAbsoluteForm(socket, options, requestHead, pending);
    } catch {
      // A malformed head must never leave the socket open on the default request timeout.
      respond(socket, 400, "Bad Request");
    }
  };
  socket.on("data", onData);
}

/** Bind the CONNECT proxy on 127.0.0.1. Rejects when the port is unavailable. */
export function startConnectProxy(port: number, options: ConnectProxyOptions): Promise<ConnectProxyHandle> {
  // Snapshot caller-owned policy before listening. Reuse the request parser's
  // host normalization; malformed policy must not silently disable restrictions.
  const allowedTargets = options.allowedTargets === undefined ? undefined : new Set(options.allowedTargets.map(authority => {
    const target = typeof authority === "string" && !/[\s\r\n]/.test(authority)
      ? parseConnectRequestLine(`CONNECT ${authority} HTTP/1.1`) : null;
    if (!target || /[*/\\?#@%]/.test(target.host)) throw new Error("Invalid CONNECT allowed target");
    return `${target.host}:${target.port}`;
  }));
  const resolved: ResolvedConnectProxyOptions = {
    interceptPort: options.interceptPort,
    authToken: options.authToken,
    interceptHosts: options.interceptHosts ?? CLAUDE_INTERCEPT_HOSTS,
    allowedTargets,
    selectTunnel: options.selectTunnel,
    dialUpstream: options.dialUpstream ?? ((host: string, targetPort: number) => connect({ host, port: targetPort })),
    forwardAbsolute: options.forwardAbsolute ?? forwardAbsoluteOverTls,
    admitInterceptSocket: options.admitInterceptSocket,
  };
  return new Promise((resolve, reject) => {
    const server: Server = createServer(socket => handleConnection(socket, resolved));
    const sockets = new Set<Socket>();
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.off("error", reject);
      const address = server.address();
      const boundPort = address && typeof address === "object" ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>(done => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
