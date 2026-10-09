import { expect, test } from "bun:test";
import { claudeCacheRetention } from "../src/claude/cache-retention";
import { anthropicToResponsesBody } from "../src/claude/inbound";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { buildClaudeReplayConfig } from "../src/server/claude-messages";
import { parseRequest } from "../src/responses/parser";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", apiKey: "offline-fixture" };
const config = { providers: { anthropic: provider }, defaultProvider: "anthropic", port: 0 } as OcxConfig;
const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hello" }] };

test("Claude subscription retention is request-local with explicit settings taking precedence", () => {
  expect(claudeCacheRetention(config, body)).toBe("long");
  expect(buildClaudeReplayConfig(config, undefined, body).cacheRetention).toBe("long");
  expect(config.cacheRetention).toBeUndefined();
  expect(claudeCacheRetention({ ...config, cacheRetention: "none" }, body)).toBe("none");
  expect(claudeCacheRetention(config, { ...body, cache_control: { type: "ephemeral", ttl: "5m" } })).toBe("short");
  expect(claudeCacheRetention(config, { ...body, system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }] })).toBe("long");
  const custom = { ...config, providers: { custom: { ...provider, authMode: "key" as const } } };
  expect(claudeCacheRetention(custom, { ...body, model: "custom/claude-opus-5-5" })).toBeUndefined();
});

test("Anthropic cache beta forwarding keeps provider authentication separate from admission", async () => {
  const budget = createTestTranslatorBudget();
  try {
    const built = await createAnthropicAdapter(provider, "long").buildRequest(parseRequest(anthropicToResponsesBody(body)), {
      headers: new Headers({ authorization: "Bearer gateway-admission", "anthropic-beta": "extended-cache-ttl-2025-04-11" }),
      translatorBudget: budget,
    });
    expect(JSON.parse(built.body).cache_control.ttl).toBe("1h");
    expect(built.headers["anthropic-beta"]).toContain("extended-cache-ttl-2025-04-11");
    expect(built.headers.Authorization).toBe("Bearer offline-fixture");
    expect(JSON.stringify(built)).not.toContain("gateway-admission");
  } finally { budget.dispose(); }
});
