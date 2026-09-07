import { describe, expect, test } from "bun:test";
import { charsPerToken, estimateTokens } from "../src/lib/token-estimate";

describe("script-segmented token estimation", () => {
  const korean = "한국어 텍스트는 토큰 밀도가 높아서 영어 기준 추정이 과소계산됩니다 ".repeat(10);
  const english = "English text estimates fine at the default four chars per token ratio ".repeat(10);
  const cjkOf = (text: string) => [...text]
    .filter(char => /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF]/.test(char)).length;
  const expected = (text: string, latinRatio: number) => {
    const cjk = cjkOf(text);
    return Math.ceil((text.length - cjk) / latinRatio + cjk / 1.5);
  };

  test("CJK characters use their own dense ratio instead of switching the whole blob", () => {
    expect(estimateTokens(korean, "gpt-5.6-sol")).toBe(expected(korean, 4));
    expect(estimateTokens(korean, "kiro/claude-opus-5")).toBe(expected(korean, 2.8));
    expect(estimateTokens(korean, "claude-sonnet-4-6")).toBe(expected(korean, 3.5));
  });

  test("pure Latin keeps the provider/model ratio", () => {
    expect(estimateTokens(english, "gpt-5.6-sol")).toBe(Math.ceil(english.length / 4));
    expect(estimateTokens(english, "kiro/claude-opus-5")).toBe(Math.ceil(english.length / 2.8));
    expect(estimateTokens(english, "claude-sonnet-4-6")).toBe(Math.ceil(english.length / 3.5));
  });

  test("Kiro's measured ratio is scoped to Kiro routes", () => {
    expect(charsPerToken("kiro/claude-opus-5")).toBe(2.8);
    expect(charsPerToken("kiro-auto")).toBe(2.8);
    for (const id of ["claude-opus-5", "deepseek-3.2", "qwen3.8-27b", "glm-5", "minimax-m2.5"]) {
      expect(charsPerToken(id)).toBe(3.5);
    }
  });

  test("estimate changes continuously across the old 30% CJK threshold", () => {
    const at = (share: number) => {
      const total = 2_000;
      const cjk = Math.round(total * share);
      return estimateTokens("한".repeat(cjk) + "a".repeat(total - cjk), "kiro/claude-opus-5");
    };
    const below = at(0.29);
    const above = at(0.31);
    expect(above).toBeGreaterThan(below);
    expect(Math.abs(above - below) / below).toBeLessThan(0.05);
  });

  test("periodic CJK in a long Latin blob cannot alias into a fake CJK-heavy sample", () => {
    const record = "id=0001,name=widget,qty=12,note=".padEnd(63, "x") + "한";
    const blob = record.repeat(400);
    const cjk = cjkOf(blob);
    expect(cjk / blob.length).toBeLessThan(0.02);
    expect(estimateTokens(blob, "kiro/claude-opus-5")).toBe(expected(blob, 2.8));
  });
});

describe("token-estimate sidecar", () => {
  test("empty string is 0 tokens", () => {
    expect(estimateTokens("", "claude-opus-4.8")).toBe(0);
  });

  test("Kiro-routed models use 2.8; the same agent families elsewhere retain 3.5", () => {
    for (const model of ["kiro-auto", "kiro/claude-opus-4.8", "kiro/deepseek-3.2", "kiro/glm-5"]) {
      expect(charsPerToken(model)).toBe(2.8);
    }
    for (const model of ["claude-opus-4.8", "deepseek-3.2", "minimax-m2.5", "glm-5", "qwen3-coder-next"]) {
      expect(charsPerToken(model)).toBe(3.5);
    }
  });

  test("unknown / undefined model falls back to 4 chars/token", () => {
    expect(charsPerToken(undefined)).toBe(4);
    expect(charsPerToken("gpt-5")).toBe(4);
  });

  test("any non-empty text is at least one token", () => {
    expect(estimateTokens("a", "kiro/claude-opus-4.8")).toBe(1);
    expect(estimateTokens("ab", "claude-opus-4.8")).toBe(1);
  });

  test("Kiro Latin estimate scales with ceil(length/2.8)", () => {
    expect(estimateTokens("x".repeat(28), "kiro/claude-opus-4.8")).toBe(10);
    expect(estimateTokens("x".repeat(29), "kiro/claude-opus-4.8")).toBe(11);
  });

  test("Kiro's denser ratio yields more tokens than generic for the same text", () => {
    const text = "x".repeat(400);
    expect(estimateTokens(text, "kiro/claude-opus-4.8")).toBeGreaterThan(estimateTokens(text, "gpt-5"));
  });

  test("monotonic: longer text never estimates fewer tokens", () => {
    let previous = 0;
    for (const length of [0, 1, 10, 100, 1000]) {
      const next = estimateTokens("x".repeat(length), "kiro/claude-opus-4.8");
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });
});
