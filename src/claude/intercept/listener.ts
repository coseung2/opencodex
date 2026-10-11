import type { Server } from "bun";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { claudeCliCatalogKind, claudeCliCatalogEligible, rewriteClaudeCliCatalog, CLI_CATALOG_MAX_BYTES, type ClaudeCliCatalogModel } from "../cli-catalog";

/**
 * TLS listener that terminates intercepted `api.anthropic.com` tunnels.
 *
 * The CONNECT proxy splices a Claude Code tunnel onto this socket; the client then speaks
 * HTTPS believing it reached Anthropic. The two exact inference paths Claude Code uses —
 * `/v1/messages` and `/v1/messages/count_tokens` — are rewritten to a loopback URL and handed
 * to the router's own request handler, which already knows how to route mapped models to
 * providers and pass genuine Claude models through with the caller's subscription credential.
 * Every other path (usage, feedback, model listings, telemetry, the environment bridge, …) is
 * relayed verbatim to the fixed native `api.anthropic.com`, so the client keeps behaving like a
 * first-party install.
 *
 * The relay target is a constant, never the caller's `Host`: `Host` is dropped on the way in and
 * the destination is pinned, so a spoofed header can neither redirect the relay nor widen it.
 *
 * The CLI picker catalog is an optional caller-gated hook; without fresh bound models,
 * catalog responses are relayed unchanged. The PEM pair is declared locally and is
 * structurally identical to the CA module's `PemKeyPair`.
 */

export const CLAUDE_INTERCEPT_UPSTREAM = "https://api.anthropic.com";

const INTERCEPTED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "host", "content-length",
  "accept-encoding",
]);

// `proxyFreeFetch` relays raw node bytes and never decompresses, so `content-encoding` describes
// exactly the bytes being forwarded and must be preserved. Only the framing/hop-by-hop headers
// are dropped. (A caller that injects a decoding `fetchImpl` owns re-adding that strip.)
const RESPONSE_STRIP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-length",
]);

/** Bounded connect phase for the relay's raw client, so an unreachable origin fails fast. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** PEM-encoded certificate/key pair. Local until `local-ca.ts` lands; kept structurally identical. */
export interface PemKeyPair {
  certPem: string;
  keyPem: string;
}

/** Router dispatch seam: receives the loopback-rewritten request and the intercept server. */
export type ClaudeInterceptDispatch<T> = (req: Request, server: Server<T>) => Promise<Response>;

export function isClaudeInterceptedPath(pathname: string, method: string): boolean {
  return method === "POST" && INTERCEPTED_PATHS.has(pathname);
}

/**
 * Rebuild the request as if the client had dialled the router directly on loopback: the
 * admission and Host checks then take the same path a plain loopback bind always has.
 */
export function rewriteInterceptedRequest(req: Request, loopbackOrigin: string): Request {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set("host", loopbackOrigin.replace(/^https?:\/\//, ""));
  return new Request(`${loopbackOrigin}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: req.body,
    signal: req.signal,
    redirect: "manual",
    // @ts-expect-error -- streaming request bodies require half duplex under the fetch spec.
    duplex: "half",
  });
}

export function forwardHeadersForUpstream(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

/** Minimal `fetch` shape the intercept needs, so a dedicated remote edge can inject its own egress. */
export type InterceptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Adapt the raw upstream response into a web stream with explicit failure and cancellation:
 * a truncated body errors instead of resolving short, and cancelling tears the upstream socket
 * down. Hand-rolled rather than `Readable.toWeb` so an aborted upstream surfaces as a stream
 * error on every supported runtime.
 */
function responseStream(response: IncomingMessage, upstream: ClientRequest): ReadableStream<Uint8Array> {
  let settled = false;
  const settle = (controller: ReadableStreamDefaultController<Uint8Array>, error?: Error): void => {
    if (settled) return;
    settled = true;
    try {
      if (error) controller.error(error);
      else controller.close();
    } catch { /* the consumer already cancelled the stream */ }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) response.pause();
      });
      response.once("end", () => settle(controller));
      response.once("error", error => settle(controller, error as Error));
      response.once("aborted", () => settle(controller, new Error("upstream aborted")));
      response.once("close", () => settle(controller, new Error("upstream closed before the body completed")));
    },
    pull() {
      if (!settled) response.resume();
    },
    cancel() {
      settled = true;
      response.destroy();
      if (!upstream.destroyed) upstream.destroy();
    },
  });
}

/**
 * `fetch`-compatible request that never consults `HTTP_PROXY`/`HTTPS_PROXY`.
 *
 * Bun's global `fetch` uses the environment proxy and its `proxy: ""` override does not disable
 * that (verified against Bun 1.4.0), so relaying to the fixed native upstream with `fetch` would
 * re-enter this same intercept and recurse. The raw `node:http`/`node:https` clients honour no
 * proxy environment, so the relay always reaches the pinned destination directly. An injected
 * `fetchImpl` replaces this for tests and for a dedicated remote edge that owns its own egress.
 */
export async function proxyFreeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const https = target.protocol === "https:";
  const method = init?.method ?? "GET";
  const headerList: Array<[string, string]> = [];
  new Headers(init?.headers).forEach((value, name) => {
    // `Host` is never taken from the caller; it is pinned to the validated destination below.
    if (name.toLowerCase() !== "host") headerList.push([name, value]);
  });
  headerList.push(["host", target.host]);
  // node's clients never decompress, so ask the origin for an identity body; if it gzips anyway
  // the raw bytes and their `content-encoding` are relayed together, and the client decodes them.
  headerList.push(["accept-encoding", "identity"]);
  const body = init?.body ?? null;
  return new Promise<Response>((resolve, reject) => {
    let receivedResponse = false;
    const send = https ? httpsRequest : httpRequest;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const clearConnectTimer = () => { if (connectTimer) clearTimeout(connectTimer); };
    const upstream = send({
      host: target.hostname,
      port: target.port === "" ? (https ? 443 : 80) : Number(target.port),
      method,
      path: `${target.pathname}${target.search}`,
      headers: Object.fromEntries(headerList),
      servername: https ? target.hostname : undefined,
      // One fresh socket per relay with no keepalive: the pooled global agent could be proxy-
      // configured, and a lingering idle socket is exactly what this hop must not retain.
      agent: false,
    }, response => {
      receivedResponse = true;
      clearConnectTimer();
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.append(name, value);
      }
      const status = response.statusCode ?? 502;
      const bodyless = status === 204 || status === 304 || method === "HEAD";
      resolve(new Response(bodyless ? null : responseStream(response, upstream), {
        status,
        statusText: response.statusMessage ?? "",
        headers,
      }));
    });
    // Bounded connect phase: an unreachable origin fails instead of holding the client's socket.
    connectTimer = setTimeout(() => upstream.destroy(new Error("upstream connect timeout")), UPSTREAM_CONNECT_TIMEOUT_MS);
    upstream.once("close", clearConnectTimer);
    upstream.once("socket", socket => {
      if (socket.connecting) socket.once(https ? "secureConnect" : "connect", clearConnectTimer);
      else clearConnectTimer();
    });
    const signal = init?.signal;
    const onAbort = () => upstream.destroy(new DOMException("Aborted", "AbortError"));
    if (signal) {
      if (signal.aborted) {
        upstream.destroy();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
    const detach = () => { if (signal) signal.removeEventListener("abort", onAbort); };
    upstream.on("error", error => {
      detach(); clearConnectTimer();
      // Preserve an early HTTP refusal (e.g. thread fallback) if the origin
      // closes its upload half. Never replace an available response with 502.
      if (!receivedResponse) reject(error);
    });
    upstream.once("close", detach);
    if (body === null || body === undefined) {
      upstream.end();
      return;
    }
    if (typeof body === "string") {
      upstream.end(body);
      return;
    }
    if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      upstream.end(body as Uint8Array);
      return;
    }
    if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
      const source = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      // A failed request-body stream must abort the upstream, not leave a half-written request.
      source.on("error", error => upstream.destroy(error as Error));
      source.pipe(upstream);
      return;
    }
    // An unsupported body would otherwise look like an empty request; fail closed and detach.
    upstream.destroy();
    detach();
    reject(new Error("unsupported request body"));
  });
}

/**
 * Relay a non-inference request to the pinned upstream. The destination is the constant
 * `upstreamBase`; nothing the caller sent selects it. Failures degrade to a fixed, sanitized
 * error — never the request URL, headers, or credential.
 */
export async function relayToUpstream(req: Request, upstreamBase: string, fetchImpl: InterceptFetch = proxyFreeFetch): Promise<Response> {
  const url = new URL(req.url);
  const target = `${upstreamBase.replace(/\/$/, "")}${url.pathname}${url.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: req.method,
      headers: forwardHeadersForUpstream(req.headers),
      body: hasBody ? req.body : undefined,
      signal: req.signal,
      redirect: "manual",
      // @ts-expect-error -- streaming request bodies require half duplex under the fetch spec.
      duplex: "half",
    });
  } catch { // no-excuse-ok: catch -- a relay failure is reported as a fixed error, never the request URL or credential.
    return Response.json(
      { type: "error", error: { type: "api_error", message: "intercept relay failed" } },
      { status: 502 },
    );
  }
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_STRIP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  // A 204/304/HEAD response must carry a null body; passing a non-null stream throws.
  const bodyless = req.method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(bodyless ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export interface ClaudeInterceptListenerOptions<T = undefined> {
  /**
   * Leaf presented for the intercepted host. Production always passes one; a test may pass
   * `null` to bind a plain-HTTP listener so the dispatch/relay handler is exercised without
   * minting a certificate. The CA and leaf lifecycle is owned by `local-ca.ts`.
   */
  leaf: PemKeyPair | null;
  /** Router request handler; receives the loopback-rewritten request and the intercept server. */
  dispatch: ClaudeInterceptDispatch<T>;
  /** Per-request decision for every path; absent dispatches every intercepted path. */
  route?: (req: Request) => "router" | "relay-native";
  /** Caller must gate this by CLI first-party intent and a fresh bound route catalog. */
  cliCatalogModels?: (req: Request) => readonly ClaudeCliCatalogModel[];
  /** Optional connection-bound admission; reject direct TLS dials before routing or relay. */
  authorize?: (req: Request, server: Server<T>) => boolean;
  /** Fixed native origin for relayed paths; defaults to `CLAUDE_INTERCEPT_UPSTREAM`. Test seam. */
  upstreamBase?: string;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  fetchImpl?: InterceptFetch;
  /** Test seam: bind a fixed port instead of an ephemeral one. */
  port?: number;
}

/** Bind the intercept TLS listener on an ephemeral loopback port. */
export function startClaudeInterceptListener<T = undefined>(options: ClaudeInterceptListenerOptions<T>): Server<T> {
  const upstreamBase = options.upstreamBase ?? CLAUDE_INTERCEPT_UPSTREAM;
  let loopbackOrigin = "";
  const server = Bun.serve<T>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    ...(options.leaf ? { tls: { cert: options.leaf.certPem, key: options.leaf.keyPem } } : {}),
    idleTimeout: options.idleTimeout ?? 255,
    ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
    async fetch(req, requestServer) {
      if (options.authorize && !options.authorize(req, requestServer)) {
        return Response.json({ type: "error", error: { type: "authentication_error", message: "Authenticated proxy tunnel required" } }, { status: 403 });
      }
      const url = new URL(req.url);
      const native = options.route?.(req) === "relay-native";
      if (!native && isClaudeInterceptedPath(url.pathname, req.method)) {
        return options.dispatch(rewriteInterceptedRequest(req, loopbackOrigin), requestServer);
      }
      const upstream = native ? CLAUDE_INTERCEPT_UPSTREAM : upstreamBase;
      const response = await relayToUpstream(req, upstream, options.fetchImpl);
      const kind = claudeCliCatalogKind(req.method, url.pathname);
      if (!kind || !options.cliCatalogModels || !claudeCliCatalogEligible(req) || response.status !== 200 || !response.body
        || !/application\/json/i.test(response.headers.get("content-type") ?? "")) return response;
      let models: readonly ClaudeCliCatalogModel[];
      try { models = options.cliCatalogModels(req); } catch { return response; }
      if (!models.length) return response;
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value); size += next.value.byteLength;
        if (size > CLI_CATALOG_MAX_BYTES) {
          let index = 0;
          return new Response(new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (index < chunks.length) { controller.enqueue(chunks[index++]!); return; }
              try { const next = await reader.read(); if (next.done) { reader.releaseLock(); controller.close(); } else controller.enqueue(next.value); }
              catch (error) { controller.error(error); }
            },
            cancel(reason) { return reader.cancel(reason).finally(() => reader.releaseLock()); },
          }), { status: response.status, headers: response.headers });
        }
      }
      reader.releaseLock();
      const original = Buffer.concat(chunks), output = rewriteClaudeCliCatalog(original, response.headers.get("content-encoding"), kind, models);
      const headers = new Headers(response.headers);
      if (output) {
        for (const name of ["content-length", "content-encoding", "etag", "digest", "content-md5", "transfer-encoding"]) headers.delete(name);
        headers.set("cache-control", "no-store");
      }
      return new Response(new Uint8Array(output ?? original).buffer, { status: response.status, headers });
    },
  });
  loopbackOrigin = `http://127.0.0.1:${server.port}`;
  return server;
}
