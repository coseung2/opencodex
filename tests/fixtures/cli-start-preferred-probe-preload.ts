import { mock } from "bun:test";
import * as liveness from "../../src/server/proxy-liveness";

mock.module("../../src/server/proxy-liveness", () => ({
  ...liveness,
  findLiveProxy: async () => null,
}));

mock.module("../../src/server", () => ({
  drainAndShutdown: async () => {},
  isRecyclingForExit: () => false,
  startServer: () => {
    console.error("unexpected duplicate startServer invocation");
    process.exit(77);
  },
}));
