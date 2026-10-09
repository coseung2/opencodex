import { expect, test } from "bun:test";
import { activeDesktop3pAlias, generateDesktop3pModels } from "../src/claude/desktop-3p";
import { emptyDesktopProfile } from "../src/claude/desktop-profile";
import { desktopFastModelId, supportsDesktopFast } from "../src/claude/desktop-speed";
import { anthropicToResponsesBody, resolveInboundModel } from "../src/claude/inbound";
import { buildAnthropicModelInfos } from "../src/claude/model-info";
import { buildClaudeReplayConfig } from "../src/server/claude-messages";
import type { OcxConfig } from "../src/types";

test("Desktop advertises Fast only on supported OpenAI routes and preserves ordinary aliases", () => {
  const native = ["gpt-5.6-sol", "gpt-5.3-codex-spark"];
  const routed = [{ provider: "cursor", id: "gpt-5.6-sol" }, { provider: "openai-apikey", id: "gpt-5.6-sol" }];
  const rows = generateDesktop3pModels(native, routed, emptyDesktopProfile());
  expect(rows.filter(m => m.labelOverride.includes("Fast"))).toHaveLength(2);
  expect(new Set(rows.map(m => m.name)).size).toBe(rows.length);
  expect(supportsDesktopFast("native", "gpt-5.3-codex-spark")).toBe(false);
  expect(supportsDesktopFast("native", "unknown-model")).toBe(false);
  const infos = buildAnthropicModelInfos(native, routed, undefined, "desktop3p", activeDesktop3pAlias);
  for (const provider of ["native", "openai-apikey"]) {
    const normal = activeDesktop3pAlias(provider, "gpt-5.6-sol");
    const fast = activeDesktop3pAlias(provider, desktopFastModelId("gpt-5.6-sol"));
    const normalInfo = infos.find(m => m.id === normal)!;
    const fastInfo = infos.find(m => m.id === fast)!;
    expect(fastInfo.display_name).toBe(`${normalInfo.display_name} - Fast`);
    expect(fastInfo.capabilities).toEqual(normalInfo.capabilities);
    expect(fastInfo.max_input_tokens).toBe(normalInfo.max_input_tokens);
    expect(rows.some(m => m.name === fast)).toBe(true);
  }
  expect(buildAnthropicModelInfos(native, routed, undefined, "readable").some(m => m.display_name.includes("Fast"))).toBe(false);
});

test("normal and Fast Desktop turns keep effort and resolve the same upstream model without changing global settings", () => {
  generateDesktop3pModels(["gpt-5.6-sol"], [], emptyDesktopProfile());
  const normal = activeDesktop3pAlias("native", "gpt-5.6-sol");
  const fast = activeDesktop3pAlias("native", desktopFastModelId("gpt-5.6-sol"));
  for (const globalFast of [true, false, undefined]) {
    const config = { providers: {}, fastMode: globalFast } as OcxConfig;
    for (const [alias, tier] of [[normal, "default"], [fast, "priority"], [normal, "default"]]) {
      const translated = anthropicToResponsesBody({ model: `${alias}[1m]`, messages: [{ role: "user", content: "hello" }], output_config: { effort: "high" } });
      expect(translated.model).toBe("gpt-5.6-sol");
      expect(translated.service_tier).toBe(tier);
      expect(translated.reasoning).toEqual({ summary: "auto", effort: "high" });
      expect(buildClaudeReplayConfig(config, translated.service_tier).fastMode).toBeUndefined();
      expect(config.fastMode).toBe(globalFast);
      expect(buildClaudeReplayConfig(config).fastMode).toBe(globalFast);
    }
  }
  expect(resolveInboundModel(`${fast}[1m]`)).toBe("gpt-5.6-sol");
  expect(anthropicToResponsesBody({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hello" }] }).service_tier).toBeUndefined();
});
