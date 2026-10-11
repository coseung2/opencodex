import type { Socket } from "node:net";

/** Bind listener admission to the live source socket of an authenticated CONNECT tunnel. */
export function createTunnelAdmission() {
  const ports = new Set<number>();
  return {
    register(socket: Socket): void {
      const port = socket.localPort;
      if (!port) throw new Error("intercept_tunnel_unavailable");
      ports.add(port);
      socket.once("close", () => ports.delete(port));
    },
    accepts(peer: { address: string; port: number } | null): boolean {
      return peer !== null && ["127.0.0.1", "::ffff:127.0.0.1"].includes(peer.address) && ports.has(peer.port);
    },
  };
}
