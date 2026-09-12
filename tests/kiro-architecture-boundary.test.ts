import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Kiro architecture boundaries", () => {
  test("kiro.ts is a facade over explicit continuity, codec, and transport modules", () => {
    const facade = read("src/adapters/kiro.ts");
    expect(facade).toContain('from "./kiro-continuity"');
    expect(facade).toContain('from "./kiro-codec"');
    expect(facade).toContain('from "./kiro-transport"');
    expect(facade).not.toContain("function validateKiroConversationState");
    expect(facade).not.toContain("decodeEventStream(");
    expect(facade).not.toContain('"x-amz-target"');
  });

  test("continuity policy cannot depend on Kiro network/auth transport", () => {
    const continuity = read("src/adapters/kiro-continuity.ts");
    for (const forbidden of [
      "resolveKiroApiRegion",
      "resolveKiroRequestProfile",
      "fetchKiroWithRetry",
      "decodeEventStream",
      "x-amz-target",
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    ]) {
      expect(continuity).not.toContain(forbidden);
    }
  });

  test("native codec maps state but cannot resolve credentials or fetch", () => {
    const codec = read("src/adapters/kiro-codec.ts");
    expect(codec).toContain("buildKiroPayload");
    expect(codec).toContain("decodeEventStream");
    expect(codec).toContain("parseKiroStream");
    for (const forbidden of [
      "resolveKiroApiRegion",
      "resolveKiroRequestProfile",
      "fetchKiroWithRetry",
      "noteKiroTransientThrottle",
      'from "./kiro-retry"',
      "authorization:",
      '"x-amz-target"',
    ]) {
      expect(codec).not.toContain(forbidden);
    }
  });

  test("native transport owns auth/wire headers but not commentary/final-answer policy", () => {
    const transport = read("src/adapters/kiro-transport.ts");
    expect(transport).toContain("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
    expect(transport).toContain('"x-amz-target"');
    expect(transport).toContain("resolveKiroApiRegion");
    expect(transport).not.toContain('phase === "commentary"');
    expect(transport).not.toContain("hasTrailingDeliveredFinalAnswer");
    expect(transport).not.toContain("KIRO_COMPLETION_INSTRUCTIONS");
  });
});
