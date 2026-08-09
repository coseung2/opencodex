import { mock } from "bun:test";
import * as liveness from "../../src/server/proxy-liveness";

let probes = 0;

mock.module("../../src/server/proxy-liveness", () => ({
  ...liveness,
  findLiveProxy: async () => {
    probes++;
    if (probes === 1) return null;
    return {
      pid: null,
      port: Number(process.env.OCX_TEST_RACE_PORT),
      hostname: "127.0.0.1",
      source: "config" as const,
    };
  },
  probeHostname: (hostname: string | undefined) => hostname ?? "127.0.0.1",
}));

mock.module("../../src/server", () => ({
  drainAndShutdown: async () => {},
  isRecyclingForExit: () => false,
  startServer: () => {
    throw Object.assign(new Error("injected bind race"), { code: "EADDRINUSE" });
  },
}));
