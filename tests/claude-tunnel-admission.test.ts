import { expect, test } from "bun:test";
import { connect } from "node:net";
import { createTunnelAdmission } from "../src/claude/intercept/tunnel-admission";
import { startConnectProxy } from "../src/claude/intercept/connect-proxy";
import { startClaudeInterceptListener } from "../src/claude/intercept/listener";

test("direct listener dial is rejected while authenticated CONNECT source socket is admitted", async () => {
  const admission = createTunnelAdmission();
  let dispatched = 0;
  const listener = startClaudeInterceptListener({ leaf: null,
    authorize: (req, server) => admission.accepts(server.requestIP(req)),
    dispatch: async () => { dispatched++; return new Response("admitted"); },
  });
  const proxy = await startConnectProxy(0, { interceptPort: listener.port!, authToken: "fixture-token", admitInterceptSocket: admission.register });
  try {
    const direct = await fetch(`http://127.0.0.1:${listener.port}/v1/messages`, { method: "POST", body: "{}" });
    expect(direct.status).toBe(403); expect(dispatched).toBe(0);
    const result = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: proxy.port }, () => socket.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from("opencodex:fixture-token").toString("base64")}\r\n\r\n`));
      let output = "", sent = false;
      socket.on("data", chunk => {
        output += chunk.toString();
        if (!sent && output.includes("200 Connection Established")) { sent = true; socket.write("POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"); }
        if (output.includes("admitted")) { socket.destroy(); resolve(output); }
      });
      socket.on("error", reject);
    });
    expect(result).toContain("admitted"); expect(dispatched).toBe(1);
  } finally { await proxy.close(); await listener.stop(true); }
});
