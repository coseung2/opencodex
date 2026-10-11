import { expect, test } from "bun:test";
import { KiroAnswerStream } from "../src/adapters/kiro-answer-stream";
test("terminal answer decodes incrementally without exposing JSON or splitting unicode escapes", () => {
  const parser = new KiroAnswerStream();
  expect(parser.push('{"ans')).toBe("");
  expect(parser.push('wer":"첫 번째 ')).toBe("첫 번째 ");
  expect(parser.push('답\\n두 번째 \\uD83D')).toBe("답\n두 번째 ");
  expect(parser.push('\\uDE00')).toBe("😀");
  expect(parser.push(' 문장"}')).toBe(" 문장");
  expect(parser.push('ignored')).toBe("");
});
test("unknown or malformed prefixes do not manufacture a final answer", () => {
  expect(new KiroAnswerStream().push('{"other":"secret"}')).toBe("");
  expect(new KiroAnswerStream().push('{"answer":null}')).toBe("");
  expect(new KiroAnswerStream().push('{"answer":"\\q"}')).toBe("");
});
