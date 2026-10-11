import { afterAll, expect, test } from "bun:test";
import { connect } from "node:net";
import type { Server } from "bun";
import {
  forwardHeadersForUpstream,
  isClaudeInterceptedPath,
  proxyFreeFetch,
  relayToUpstream,
  rewriteInterceptedRequest,
  startClaudeInterceptListener,
} from "../src/claude/intercept/listener";

/**
 * Focused coverage for the intercept TLS listener's dispatch/relay handler and its proxy-free
 * upstream egress. `leaf: null` binds a plain-HTTP listener so the handler is exercised without
 * minting a certificate; the CA/leaf lifecycle is owned by local-ca.ts. Every upstream is a local
 * mock — no real account calls, no external network.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function rawHttp(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(payload));
    let out = "";
    // A plain-HTTP server may keep the connection alive despite `Connection: close`, so bound the
    // wait and return what arrived rather than depending on a FIN.
    const timer = setTimeout(() => { socket.destroy(); resolve(out); }, 1500);
    const finish = () => { clearTimeout(timer); resolve(out); };
    socket.on("data", chunk => { out += chunk.toString("latin1"); });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });
}

async function mockUpstream(record: Array<{ method: string; path: string; host: string | null }>): Promise<Server> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      record.push({ method: req.method, path: new URL(req.url).pathname, host: req.headers.get("host") });
      return Response.json({ upstream: true });
    },
  });
  cleanups.push(() => server.stop(true));
  return server;
}

test("isClaudeInterceptedPath admits only the two exact POST inference paths", () => {
  expect(isClaudeInterceptedPath("/v1/messages", "POST")).toBe(true);
  expect(isClaudeInterceptedPath("/v1/messages/count_tokens", "POST")).toBe(true);
  expect(isClaudeInterceptedPath("/v1/messages", "GET")).toBe(false);
  expect(isClaudeInterceptedPath("/v1/messages/count_tokens/", "POST")).toBe(false);
  expect(isClaudeInterceptedPath("/v1/models", "POST")).toBe(false);
});

test("rewriteInterceptedRequest moves onto the loopback origin and keeps path, query and headers", () => {
  const original = new Request("https://api.anthropic.com/v1/messages?x=1", {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", host: "api.anthropic.com" },
    body: "{}",
  });
  const rewritten = rewriteInterceptedRequest(original, "http://127.0.0.1:4567");
  expect(rewritten.url).toBe("http://127.0.0.1:4567/v1/messages?x=1");
  expect(rewritten.headers.get("host")).toBe("127.0.0.1:4567");
  expect(rewritten.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(rewritten.method).toBe("POST");
});

test("forwardHeadersForUpstream drops Host and hop-by-hop, keeps caller headers", () => {
  const source = new Headers({
    host: "api.anthropic.com",
    connection: "keep-alive",
    "content-length": "3",
    "accept-encoding": "gzip",
    "proxy-authorization": "Basic x",
    "x-api-key": "sk-ant-test",
    "anthropic-version": "2023-06-01",
  });
  const headers = forwardHeadersForUpstream(source);
  for (const dropped of ["host", "connection", "content-length", "accept-encoding", "proxy-authorization"]) {
    expect(headers.get(dropped)).toBeNull();
  }
  expect(headers.get("x-api-key")).toBe("sk-ant-test");
  expect(headers.get("anthropic-version")).toBe("2023-06-01");
});

test("relayToUpstream reports a fixed, sanitized error and never the URL or credential", async () => {
  const res = await relayToUpstream(
    new Request("https://api.anthropic.com/v1/models"),
    "https://api.anthropic.com",
    () => { throw new Error("connect failed for https://api.anthropic.com/v1/models?key=sk-ant-secret"); },
  );
  expect(res.status).toBe(502);
  const body = await res.json() as { error: { message: string } };
  expect(body.error.message).toBe("intercept relay failed");
  expect(JSON.stringify(body)).not.toContain("sk-ant-secret");
  expect(JSON.stringify(body)).not.toContain("/v1/models");
});

test("relay preserves a raw gzip body and its content-encoding; 204/HEAD carry no body", async () => {
  const payload = "hello-gzip";
  const gzipped = Bun.gzipSync(new TextEncoder().encode(payload));
  const gzipServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() { return new Response(gzipped, { headers: { "content-encoding": "gzip", "content-type": "text/plain" } }); },
  });
  const emptyServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { return new Response(null, { status: req.method === "HEAD" ? 200 : 204 }); } });
  try {
    const gzipBase = `http://127.0.0.1:${gzipServer.port}`;
    const relayed = await relayToUpstream(new Request(`${gzipBase}/static`), gzipBase);
    expect(relayed.headers.get("content-encoding")).toBe("gzip");
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await relayed.arrayBuffer())))).toBe(payload);

    const emptyBase = `http://127.0.0.1:${emptyServer.port}`;
    const noContent = await relayToUpstream(new Request(`${emptyBase}/healthz`), emptyBase);
    expect(noContent.status).toBe(204);
    expect(noContent.body).toBeNull();

    const head = await relayToUpstream(new Request(`${emptyBase}/v1/models`, { method: "HEAD" }), emptyBase);
    expect(head.body).toBeNull();
  } finally {
    gzipServer.stop(true);
    emptyServer.stop(true);
  }
});

test("a mid-body upstream failure surfaces as a stream error, not a truncated success", async () => {
  const failing = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      setTimeout(() => controller.error(new Error("boom")), 5);
    },
  });
  const res = await relayToUpstream(
    new Request("http://native.test/v1/models"),
    "http://native.test",
    async () => new Response(failing, { headers: { "content-type": "text/plain" } }),
  );
  expect(res.status).toBe(200);
  await expect(res.text()).rejects.toThrow("boom");
});

test("cancelling the relayed body cancels the upstream stream", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
    cancel() { cancelled = true; },
  });
  const res = await relayToUpstream(
    new Request("http://native.test/v1/models"),
    "http://native.test",
    async () => new Response(source, { headers: { "content-type": "text/plain" } }),
  );
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);
});

test("listener dispatches the exact inference paths and relays everything else to the pinned upstream", async () => {
  const record: Array<{ method: string; path: string; host: string | null }> = [];
  const upstream = await mockUpstream(record);
  const dispatched: Request[] = [];
  const listener = startClaudeInterceptListener({
    leaf: null,
    upstreamBase: `http://127.0.0.1:${upstream.port}`,
    dispatch: async req => {
      dispatched.push(req);
      const body = await req.text();
      return Response.json({ dispatched: true, url: req.url, host: req.headers.get("host"), body });
    },
  });
  cleanups.push(() => listener.stop(true));
  const origin = `http://127.0.0.1:${listener.port}`;

  const messages = await fetch(`${origin}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
    body: JSON.stringify({ model: "claude-x" }),
  });
  expect(messages.status).toBe(200);
  const json = await messages.json() as { dispatched: boolean; url: string; host: string; body: string };
  expect(json.dispatched).toBe(true);
  expect(json.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/messages\?beta=true$/);
  expect(json.host).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(json.body).toBe(JSON.stringify({ model: "claude-x" }));
  expect(dispatched[0]!.headers.get("x-api-key")).toBe("sk-ant-test");

  const counted = await fetch(`${origin}/v1/messages/count_tokens`, { method: "POST", body: "{}" });
  expect(counted.status).toBe(200);
  expect(dispatched).toHaveLength(2);

  // GET on a messages path is not an inference request: relayed, never dispatched.
  await fetch(`${origin}/v1/messages`);
  expect(dispatched).toHaveLength(2);
  expect(record.at(-1)).toEqual({ method: "GET", path: "/v1/messages", host: `127.0.0.1:${upstream.port}` });

  // Other paths are the client's own business with the fixed upstream (native non-inference).
  const models = await fetch(`${origin}/v1/models?limit=1`);
  expect(await models.json()).toEqual({ upstream: true });
  expect(record.at(-1)).toEqual({ method: "GET", path: "/v1/models", host: `127.0.0.1:${upstream.port}` });
});

test("a spoofed caller Host cannot redirect the relay destination", async () => {
  const record: Array<{ method: string; path: string; host: string | null }> = [];
  const upstream = await mockUpstream(record);
  const listener = startClaudeInterceptListener({
    leaf: null,
    upstreamBase: `http://127.0.0.1:${upstream.port}`,
    dispatch: async () => Response.json({ dispatched: true }),
  });
  cleanups.push(() => listener.stop(true));
  const response = await rawHttp(listener.port!, `GET /v1/models HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
  expect(response).toStartWith("HTTP/1.1 200");
  expect(record).toEqual([{ method: "GET", path: "/v1/models", host: `127.0.0.1:${upstream.port}` }]);
});

// Kept last: it mutates the proxy environment, and an early global `fetch` on Bun can latch the
// proxy it observes, which would disturb the loopback listeners above.
test("proxyFreeFetch ignores HTTP_PROXY/HTTPS_PROXY (no recursion into this intercept)", async () => {
  const previous = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY };
  let trapHits = 0;
  const trap = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { trapHits += 1; return new Response("trap"); } });
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response("target"); } });
  process.env.HTTP_PROXY = `http://127.0.0.1:${trap.port}`;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${trap.port}`;
  delete process.env.NO_PROXY;
  try {
    const res = await proxyFreeFetch(`http://127.0.0.1:${target.port}/v1/models`);
    expect(await res.text()).toBe("target");
    expect(trapHits).toBe(0);
  } finally {
    if (previous.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous.HTTP_PROXY;
    if (previous.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous.HTTPS_PROXY;
    if (previous.NO_PROXY === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous.NO_PROXY;
    trap.stop(true);
    target.stop(true);
  }
});
