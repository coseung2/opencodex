import { expect, test } from "bun:test";
import { sessionLaneIdFromRequest } from "../src/server/request-log-conversation";
import { resolveOpenCodeGoTransport } from "../src/providers/opencode-go-transport";
import type { OcxProviderConfig } from "../src/types";

test("routed Claude internal scope keeps Go session header stable", () => {
  const provider = { adapter: "openai-chat", authMode: "key", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "synthetic" } as OcxProviderConfig;
  const lane = (scope: string) => sessionLaneIdFromRequest(new Headers({ "x-ocx-claude-session-scope": scope }));
  expect(lane("one")).toBe("one");
  const first = resolveOpenCodeGoTransport(provider, lane("one"));
  const second = resolveOpenCodeGoTransport(provider, lane("one"));
  expect(first.headers?.["x-opencode-session"]).toBe(second.headers?.["x-opencode-session"]);
  expect(first.headers?.["x-opencode-session"]).not.toBe(resolveOpenCodeGoTransport(provider, lane("two")).headers?.["x-opencode-session"]);
});
