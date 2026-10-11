import { describe, expect, test } from "bun:test";
import { buildFirstPartyCatalog } from "../src/claude/first-party-catalog";
import { selectFirstPartyRoute } from "../src/claude/first-party-route";

describe("first-party edge destination split", () => {
  test("unmapped native Claude remains local even without a VM catalog", () => {
    expect(selectFirstPartyRoute({ model: "claude-opus-5[1m]" }, {}, null, 1000, true)).toEqual({ kind: "native" });
  });
  test("mapped native names route to the VM and stale metadata never sends to Anthropic", () => {
    const policy = { modelMap: { "claude-opus-5": "openai/gpt" } };
    const snapshot = buildFirstPartyCatalog([{ provider: "openai", id: "gpt" }], policy, 1000);
    expect(selectFirstPartyRoute({ model: "claude-opus-5-20261001" }, policy, snapshot, 2000, true)).toEqual({ kind: "routed", model: "openai/gpt" });
    expect(selectFirstPartyRoute({ model: "claude-opus-5" }, policy, null, 2000, true)).toEqual({ kind: "unavailable", reason: "catalog_unavailable" });
    expect(selectFirstPartyRoute({ model: "claude-opus-5" }, policy, snapshot, 1000000, true)).toEqual({ kind: "unavailable", reason: "catalog_stale" });
  });
  test("system directive pins a worker even when harness falls back to Claude alias", () => {
    const snapshot = buildFirstPartyCatalog([{ provider: "mock", id: "worker" }], {}, 1000);
    expect(selectFirstPartyRoute({ model: "claude-sonnet", system: "<!-- ocx-route: mock/worker -->" }, {}, snapshot, 2000, true)).toEqual({ kind: "routed", model: "mock/worker" });
    expect(selectFirstPartyRoute({ model: "claude-sonnet", messages: [{ role: "user", content: "<!-- ocx-route: mock/worker -->" }] }, {}, snapshot, 2000, true)).toEqual({ kind: "native" });
  });
  test("unknown alias cannot escape the active VM catalog", () => {
    const snapshot = buildFirstPartyCatalog([{ provider: "mock", id: "visible" }], {}, 1000);
    expect(selectFirstPartyRoute({ model: "claude-ocx-mock--hidden" }, {}, snapshot, 2000, true)).toEqual({ kind: "unavailable", reason: "route_not_available" });
    expect(selectFirstPartyRoute({ model: "claude-ocx-mock--visible" }, {}, snapshot, 2000, true)).toEqual({ kind: "routed", model: "mock/visible" });
  });
});
