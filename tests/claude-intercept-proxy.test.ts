import { afterAll, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import {
  CLAUDE_BRIDGE_HOST,
  CLAUDE_BRIDGE_PATH,
  isAllowedBridgeTarget,
  isLoopbackTarget,
  parseAbsoluteFormRequestLine,
  parseConnectRequestLine,
  startConnectProxy,
  type AbsoluteForwardRequest,
  type ConnectProxyHandle,
} from "../src/claude/intercept/connect-proxy";

/**
 * Focused coverage for the intercept CONNECT proxy: authentication, limits, blind splicing with
 * pipelined bytes, cancellation, and the single narrow absolute-form forward of the native,
 * non-inference environment bridge. No real network and no TLS: blind tunnels terminate at a local
 * echo socket and the absolute-form forward is an injected test seam.
 */

const cleanups: Array<() => Promise<void> | void> = [];
const AUTH_TOKEN = "test-proxy-token";
const AUTH_HEADER = `Proxy-Authorization: Basic ${Buffer.from(`opencodex:${AUTH_TOKEN}`).toString("base64")}\r\n`;
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(payload));
    let out = "";
    socket.on("data", chunk => { out += chunk.toString("latin1"); });
    socket.on("end", () => resolve(out));
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
  });
}

async function startEchoUpstream(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(socket => socket.on("data", chunk => socket.write(`echo:${chunk.toString()}`)));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return { port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

function tunnelPayload(port: number, host: string, payload = "hello"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () =>
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${AUTH_HEADER}\r\n${payload}`));
    let out = "";
    socket.on("data", chunk => {
      out += chunk.toString("latin1");
      if (out.includes(`echo:${payload}`)) { socket.end(); resolve(out); }
    });
    socket.on("error", reject);
  });
}

function chunked(...parts: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const part of parts) yield new TextEncoder().encode(part);
  })();
}

test("parseConnectRequestLine accepts host:port and bracketed IPv6, rejects the rest", () => {
  expect(parseConnectRequestLine("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: x")).toEqual({ host: "api.anthropic.com", port: 443 });
  expect(parseConnectRequestLine("CONNECT API.Anthropic.COM.:443 HTTP/1.0")).toEqual({ host: "api.anthropic.com", port: 443 });
  expect(parseConnectRequestLine("CONNECT [::1]:8443 HTTP/1.1")).toEqual({ host: "::1", port: 8443 });
  expect(parseConnectRequestLine("GET http://example.com/ HTTP/1.1")).toBeNull();
  expect(parseConnectRequestLine("CONNECT example.com HTTP/1.1")).toBeNull();
  expect(parseConnectRequestLine("CONNECT example.com:99999 HTTP/1.1")).toBeNull();
});

test("parseAbsoluteFormRequestLine admits only the exact https bridge target", () => {
  const bridge = parseAbsoluteFormRequestLine(`GET https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1`);
  expect(bridge).not.toBeNull();
  expect(bridge!.method).toBe("GET");
  expect(bridge!.host).toBe(CLAUDE_BRIDGE_HOST);
  expect(bridge!.port).toBe(443);
  expect(bridge!.path).toBe(CLAUDE_BRIDGE_PATH);
  expect(parseAbsoluteFormRequestLine(`POST https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH}?beta=1 HTTP/1.1`)!.path)
    .toBe(`${CLAUDE_BRIDGE_PATH}?beta=1`);
  // Normalization and refusal shapes.
  expect(parseAbsoluteFormRequestLine(`GET https://${CLAUDE_BRIDGE_HOST}.:443${CLAUDE_BRIDGE_PATH} HTTP/1.1`)!.host).toBe(CLAUDE_BRIDGE_HOST);
  expect(parseAbsoluteFormRequestLine(`GET http://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1`)).toBeNull();
  expect(parseAbsoluteFormRequestLine(`CONNECT ${CLAUDE_BRIDGE_HOST}:443 HTTP/1.1`)).toBeNull();
  expect(parseAbsoluteFormRequestLine(`GET https://${CLAUDE_BRIDGE_HOST}:8443${CLAUDE_BRIDGE_PATH} HTTP/1.1`)).toBeNull();
  expect(parseAbsoluteFormRequestLine(`GET https://user:pass@${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1`)).toBeNull();
  expect(parseAbsoluteFormRequestLine(`DELETE https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1`)).toBeNull();
  expect(parseAbsoluteFormRequestLine(`/v1/messages HTTP/1.1`)).toBeNull();
});

test("isAllowedBridgeTarget matches host and exact path only", () => {
  const bridge = parseAbsoluteFormRequestLine(`GET https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1`)!;
  expect(isAllowedBridgeTarget(bridge)).toBe(true);
  expect(isAllowedBridgeTarget(parseAbsoluteFormRequestLine(`GET https://${CLAUDE_BRIDGE_HOST}/v1/models HTTP/1.1`)!)).toBe(false);
  expect(isAllowedBridgeTarget(parseAbsoluteFormRequestLine(`GET https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH}/ HTTP/1.1`)!)).toBe(false);
});

test("isLoopbackTarget covers mapped, unspecified and shorthand loopback literals", () => {
  for (const host of ["localhost", "foo.localhost", "127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0.0.0.0", "::", "127.1", "0x7f000001", "2130706433"]) {
    expect(isLoopbackTarget(host)).toBe(true);
  }
  for (const host of ["api.anthropic.com", "10.0.0.1", "::ffff:10.0.0.1", "2606:4700::1", "1.example"]) {
    expect(isLoopbackTarget(host)).toBe(false);
  }
});

test("CONNECT requires the per-install credential and every refusal carries the Basic challenge", async () => {
  const proxy = await startConnectProxy(0, { interceptPort: 1, authToken: () => null, dialUpstream: () => { throw new Error("unexpected dial"); } });
  cleanups.push(proxy.close);
  for (const header of ["", "Proxy-Authorization: Basic invalid\r\n"]) {
    const response = await rawRequest(proxy.port, `CONNECT telemetry.example:443 HTTP/1.1\r\nHost: telemetry.example:443\r\n${header}\r\n`);
    expect(response).toStartWith("HTTP/1.1 407");
    expect(response).toContain('\r\nProxy-Authenticate: Basic realm="OpenCodex"\r\n');
  }
});

test("duplicate Proxy-Authorization is refused as ambiguous before any auth decision", async () => {
  let dials = 0;
  const proxy = await startConnectProxy(0, { interceptPort: 1, authToken: AUTH_TOKEN, dialUpstream: () => { dials += 1; throw new Error("unexpected dial"); } });
  cleanups.push(proxy.close);
  const connectDup = await rawRequest(proxy.port, `CONNECT telemetry.example:443 HTTP/1.1\r\n${AUTH_HEADER}${AUTH_HEADER}\r\n`);
  expect(connectDup).toStartWith("HTTP/1.1 400");
  const absoluteDup = await rawRequest(proxy.port, `GET https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1\r\n${AUTH_HEADER}${AUTH_HEADER}\r\n`);
  expect(absoluteDup).toStartWith("HTTP/1.1 400");
  expect(dials).toBe(0);
});

test("other CONNECT targets are relayed blind, including pipelined bytes after the head", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    dialUpstream: (host, port) => {
      expect(host).toBe("telemetry.example");
      expect(port).toBe(443);
      return connect({ host: "127.0.0.1", port: echo.port });
    },
  });
  cleanups.push(proxy.close);
  const out = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxy.port }, () => {
      socket.write(`CONNECT telemetry.example:443 HTTP/1.1\r\nHost: telemetry.example:443\r\n${AUTH_HEADER}\r\nhello`);
    });
    let buf = "";
    socket.on("data", chunk => {
      buf += chunk.toString("latin1");
      if (buf.includes("echo:hello")) { socket.end(); resolve(buf); }
    });
    socket.on("error", reject);
  });
  expect(out.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true);
  expect(out).toContain("echo:hello");
});

test("intercepted hosts splice onto the configured intercept port", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const proxy = await startConnectProxy(0, { interceptPort: echo.port, authToken: AUTH_TOKEN });
  cleanups.push(proxy.close);
  expect(await tunnelPayload(proxy.port, "api.anthropic.com")).toContain("echo:hello");
});

test("invalid request and loopback are refused before consulting tunnel choice", async () => {
  let consulted = 0;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: () => { consulted += 1; return { kind: "blind" }; },
  });
  cleanups.push(proxy.close);
  expect(await rawRequest(proxy.port, "GET http://example.com/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 405");
  expect(await rawRequest(proxy.port, `CONNECT localhost:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(consulted).toBe(0);
});

test("restricted CONNECT admits only exact normalized authorities before tunnel selection", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const selected: string[] = [];
  let blindDials = 0;
  const allowedTargets = ["CHATGPT.COM.:443"];
  const proxy = await startConnectProxy(0, {
    interceptPort: echo.port,
    interceptHosts: ["chatgpt.com"],
    allowedTargets,
    selectTunnel: (host, port) => { selected.push(`${host}:${port}`); return null; },
    dialUpstream: () => { blindDials++; return connect({ host: "127.0.0.1", port: echo.port }); },
  });
  cleanups.push(proxy.close);
  // A caller mutating its original array cannot broaden a running listener.
  allowedTargets.push("other.example:443");
  expect(await tunnelPayload(proxy.port, "ChatGPT.Com.")).toContain("echo:hello");
  for (const authority of ["other.example:443", "chatgpt.com:8443", "child.chatgpt.com:443", "chatgpt.com.evil.example:443"]) {
    expect(await rawRequest(proxy.port, `CONNECT ${authority} HTTP/1.1\r\nUser-Agent: Mozilla/test\r\n\r\npipelined`)).toStartWith("HTTP/1.1 403");
  }
  expect(selected).toEqual(["chatgpt.com:443"]);
  expect(blindDials).toBe(0);
});

test("malformed destination restrictions fail before a listener starts", () => {
  for (const authority of ["", "*.example.com:443", "example.com", "example.com:0", "example.com:65536", "example.com:443\r\nX: value", "https://example.com:443"]) {
    expect(() => startConnectProxy(0, { interceptPort: 1, allowedTargets: [authority] })).toThrow("Invalid CONNECT allowed target");
  }
});

test("plain proxied HTTP, loopback targets and oversized heads are refused", async () => {
  const proxy = await startConnectProxy(0, { interceptPort: 1, authToken: AUTH_TOKEN });
  cleanups.push(proxy.close);
  expect(await rawRequest(proxy.port, `GET https://${CLAUDE_BRIDGE_HOST}/v1/models HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(await rawRequest(proxy.port, `CONNECT 127.0.0.1:22 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(await rawRequest(proxy.port, `CONNECT [::ffff:127.0.0.1]:22 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(await rawRequest(proxy.port, `CONNECT a:443 HTTP/1.1\r\nX: ${"y".repeat(9000)}`)).toStartWith("HTTP/1.1 431");
  expect(await rawRequest(proxy.port, `CONNECT a:443 HTTP/1.1\r\nX: ${"y".repeat(9000)}\r\n\r\n`)).toStartWith("HTTP/1.1 431");
});

test("a dead upstream yields 502 instead of a hung tunnel", async () => {
  const dead = await startEchoUpstream();
  await dead.close();
  const proxy = await startConnectProxy(0, { interceptPort: 1, authToken: AUTH_TOKEN, dialUpstream: () => connect({ host: "127.0.0.1", port: dead.port }) });
  cleanups.push(proxy.close);
  expect(await rawRequest(proxy.port, `CONNECT gone.example:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 502");
});

test("per-connection override chooses its own listener or blind tunnel", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const selected: string[] = [];
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: (host, port) => { selected.push(`${host}:${port}`); return host === "claude.ai" ? { kind: "intercept", port: echo.port } : { kind: "blind" }; },
    dialUpstream: () => connect({ host: "127.0.0.1", port: echo.port }),
  });
  cleanups.push(proxy.close);
  expect(await tunnelPayload(proxy.port, "claude.ai")).toContain("echo:hello");
  expect(await tunnelPayload(proxy.port, "other.example")).toContain("echo:hello");
  expect(selected).toEqual(["claude.ai:443", "other.example:443"]);
});

test("pending async choice holds pipelined bytes, then connects; rejection falls back blind", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  let settle!: (choice: { kind: "intercept"; port: number }) => void;
  let dialCount = 0;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: host => host === "claude.ai"
      ? new Promise(resolve => { settle = resolve; })
      : Promise.reject(new Error("decision failed")),
    dialUpstream: () => { dialCount += 1; return connect({ host: "127.0.0.1", port: echo.port }); },
  });
  cleanups.push(proxy.close);
  const delayed = tunnelPayload(proxy.port, "claude.ai", "pending");
  await Bun.sleep(20);
  expect(dialCount).toBe(0);
  settle({ kind: "intercept", port: echo.port });
  expect(await delayed).toContain("echo:pending");
  expect(dialCount).toBe(0);
  expect(await tunnelPayload(proxy.port, "failed.example", "blind")).toContain("echo:blind");
  expect(dialCount).toBe(1);
});

test("a closed client during an async decision causes no upstream dial", async () => {
  let settle!: (choice: { kind: "blind" }) => void;
  let dialCount = 0;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: () => new Promise(resolve => { settle = resolve; }),
    dialUpstream: () => { dialCount += 1; return connect({ host: "127.0.0.1", port: 1 }); },
  });
  cleanups.push(proxy.close);
  const client: Socket = connect({ host: "127.0.0.1", port: proxy.port }, () => client.write(`CONNECT claude.ai:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`));
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (!settle) return;
      clearInterval(check);
      client.destroy();
      client.once("close", resolve);
    }, 1);
  });
  await Bun.sleep(20);
  settle({ kind: "blind" });
  await Bun.sleep(0);
  expect(dialCount).toBe(0);
});

test("handle.close() tears down tracked sockets and releases the port", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const proxy = await startConnectProxy(0, { interceptPort: echo.port, authToken: AUTH_TOKEN });
  // Hold a live tunnel open, then close: the tracked client socket must be destroyed.
  const held: Socket = connect({ host: "127.0.0.1", port: proxy.port }, () => held.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\n${AUTH_HEADER}\r\nhello`));
  await new Promise<void>(resolve => held.once("data", () => resolve()));
  const closed = new Promise<void>(resolve => held.once("close", () => resolve()));
  await proxy.close();
  await closed;
  const outcome = await new Promise<string>(resolve => {
    const socket = connect({ host: "127.0.0.1", port: proxy.port }, () => { socket.destroy(); resolve("open"); });
    socket.on("error", () => resolve("refused"));
  });
  expect(outcome).toBe("refused");
});

// ── Narrow absolute-form bridge forward ─────────────────────────────────────────

interface ForwardCapture { request: AbsoluteForwardRequest }

async function startAbsoluteProxy(capture: ForwardCapture[], bodyParts = ['{"ok":true}']): Promise<ConnectProxyHandle> {
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    forwardAbsolute: request => {
      capture.push({ request });
      return {
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json", connection: "keep-alive", "content-length": "999" }),
        body: chunked(...bodyParts),
      };
    },
  });
  cleanups.push(proxy.close);
  return proxy;
}

test("absolute-form bridge forward relays the native path and strips proxy/hop-by-hop headers", async () => {
  const capture: ForwardCapture[] = [];
  const proxy = await startAbsoluteProxy(capture);
  const response = await rawRequest(proxy.port,
    `POST https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH}?beta=1 HTTP/1.1\r\n`
    + `Host: ${CLAUDE_BRIDGE_HOST}\r\n`
    + `${AUTH_HEADER}`
    + `Proxy-Connection: keep-alive\r\n`
    + `Content-Length: 5\r\n\r\nhello`);
  expect(response).toStartWith("HTTP/1.1 200 OK\r\n");
  // Response is re-framed chunked and the upstream connection/content-length headers are dropped.
  expect(response).toContain("transfer-encoding: chunked");
  expect(response).not.toContain("content-length: 999");
  expect(response).toContain('{"ok":true}');

  expect(capture).toHaveLength(1);
  const { request } = capture[0]!;
  expect(request.method).toBe("POST");
  expect(request.host).toBe(CLAUDE_BRIDGE_HOST);
  expect(request.port).toBe(443);
  expect(request.path).toBe(`${CLAUDE_BRIDGE_PATH}?beta=1`);
  // The proxy credential never leaks upstream, and Host is pinned to the fixed destination.
  expect(request.headers.get("proxy-authorization")).toBeNull();
  expect(request.headers.get("proxy-connection")).toBeNull();
  expect(request.headers.get("content-length")).toBeNull();
  expect(request.headers.get("host")).toBe(CLAUDE_BRIDGE_HOST);
  expect(new TextDecoder().decode(request.body!)).toBe("hello");
});

test("absolute-form forwarding never becomes an open HTTP proxy", async () => {
  let forwarded = 0;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    forwardAbsolute: () => { forwarded += 1; return { status: 200, statusText: "OK", headers: new Headers(), body: null }; },
  });
  cleanups.push(proxy.close);
  const rejected: Array<[string, string]> = [
    [`GET https://evil.example/v1/environments/bridge HTTP/1.1`, "403"],
    [`GET https://${CLAUDE_BRIDGE_HOST}/v1/models HTTP/1.1`, "403"],
    [`GET https://${CLAUDE_BRIDGE_HOST}/v1/messages HTTP/1.1`, "403"],
    [`GET https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH}/ HTTP/1.1`, "403"],
    [`GET http://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1`, "405"],
    [`/v1/environments/bridge HTTP/1.1`, "405"],
  ];
  for (const [line, status] of rejected) {
    expect(await rawRequest(proxy.port, `${line}\r\nHost: ${CLAUDE_BRIDGE_HOST}\r\n${AUTH_HEADER}\r\n`)).toStartWith(`HTTP/1.1 ${status}`);
  }
  expect(forwarded).toBe(0);
});

test("absolute-form bridge requires the proxy credential; an unauthenticated proxy refuses it", async () => {
  let forwarded = 0;
  const authenticated = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    forwardAbsolute: () => { forwarded += 1; return { status: 200, statusText: "OK", headers: new Headers(), body: null }; },
  });
  cleanups.push(authenticated.close);
  const line = `GET https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1\r\nHost: ${CLAUDE_BRIDGE_HOST}\r\n`;
  const missing = await rawRequest(authenticated.port, `${line}\r\n`);
  expect(missing).toStartWith("HTTP/1.1 407");
  expect(missing).toContain('\r\nProxy-Authenticate: Basic realm="OpenCodex"\r\n');
  expect(await rawRequest(authenticated.port, `${line}Proxy-Authorization: Basic bad\r\n\r\n`)).toStartWith("HTTP/1.1 407");
  expect(forwarded).toBe(0);

  const open = await startConnectProxy(0, { interceptPort: 1, forwardAbsolute: () => { forwarded += 1; return { status: 200, statusText: "OK", headers: new Headers(), body: null }; } });
  cleanups.push(open.close);
  expect(await rawRequest(open.port, `${line}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(forwarded).toBe(0);
});

test("ambiguous or malformed absolute-form framing is refused", async () => {
  const capture: ForwardCapture[] = [];
  const proxy = await startAbsoluteProxy(capture);
  const base = `POST https://${CLAUDE_BRIDGE_HOST}${CLAUDE_BRIDGE_PATH} HTTP/1.1\r\n${AUTH_HEADER}`;
  // Host disagrees with the absolute target.
  expect(await rawRequest(proxy.port, `${base}Host: evil.example\r\nContent-Length: 0\r\n\r\n`)).toStartWith("HTTP/1.1 400");
  // Duplicate Host.
  expect(await rawRequest(proxy.port, `${base}Host: ${CLAUDE_BRIDGE_HOST}\r\nHost: ${CLAUDE_BRIDGE_HOST}\r\nContent-Length: 0\r\n\r\n`)).toStartWith("HTTP/1.1 400");
  // Content-Length and Transfer-Encoding together.
  expect(await rawRequest(proxy.port, `${base}Content-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n`)).toStartWith("HTTP/1.1 400");
  // Over-budget buffered body.
  expect(await rawRequest(proxy.port, `${base}Content-Length: ${3 * 1024 * 1024}\r\n\r\nx`)).toStartWith("HTTP/1.1 413");
  expect(capture).toHaveLength(0);
});

test("optionally present bridge target still needs an exact host match", () => {
  // Regression guard: the constant is the allowlist, not a suffix.
  expect(CLAUDE_BRIDGE_HOST).toBe("api.anthropic.com");
  expect(CLAUDE_BRIDGE_PATH).toBe("/v1/environments/bridge");
});
