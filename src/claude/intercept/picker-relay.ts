import { relayToUpstream, type InterceptFetch } from "./listener";
import { isPickerBootstrapRequest, rewriteBootstrapBody, BOOTSTRAP_MAX_ENCODED_BYTES, type PickerModelEntry, type PickerInjectionOutcome } from "./picker-bootstrap";

export interface PickerRelayOptions {
  models(): readonly PickerModelEntry[];
  fetchImpl?: InterceptFetch;
  outcome?(value: PickerInjectionOutcome): void;
}
/** Fixed-origin relay: only successful local Code bootstrap rows are rewritten. */
export function createPickerRelay(options: PickerRelayOptions): (request: Request) => Promise<Response> {
  return async request => {
    const bootstrap = isPickerBootstrapRequest(request.method, new URL(request.url).pathname);
    const source = bootstrap ? new Request(request, { headers: new Headers(request.headers) }) : request;
    if (bootstrap) source.headers.set("accept-encoding", "identity");
    const response = await relayToUpstream(source, "https://claude.ai", options.fetchImpl);
    if (!bootstrap || response.status !== 200 || !response.body
      || !/\bapplication\/json\b/i.test(response.headers.get("content-type") ?? "")) return response;
    const models = options.models();
    if (!models.length) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value); size += next.value.length;
        if (size > BOOTSTRAP_MAX_ENCODED_BYTES) {
          options.outcome?.({ kind: "unchanged", reason: "encoded_cap" });
          let index = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (index < chunks.length) { controller.enqueue(chunks[index++]!); return; }
              try { const next = await reader.read(); if (next.done) { reader.releaseLock(); controller.close(); } else controller.enqueue(next.value); }
              catch (error) { controller.error(error); }
            },
            cancel(reason) { return reader.cancel(reason).finally(() => reader.releaseLock()); },
          });
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { if (size <= BOOTSTRAP_MAX_ENCODED_BYTES) reader.releaseLock(); }
    const original = Buffer.concat(chunks);
    const output = rewriteBootstrapBody(original, response.headers.get("content-encoding") ?? undefined, models, options.outcome);
    const headers = new Headers(response.headers);
    if (output) {
      for (const name of ["content-encoding", "content-length", "etag", "digest", "content-md5", "transfer-encoding"]) headers.delete(name);
      headers.set("content-length", String(output.length));
      headers.set("cache-control", "no-store");
    }
    return new Response(new Uint8Array(output ?? original).buffer, { status: response.status, statusText: response.statusText, headers });
  };
}
