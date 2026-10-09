import { expect, test } from "bun:test";

test("cache panel gates polling and avoids inferred expiry", async () => {
  const source = await Bun.file(new URL("../src/pages/claude-code-cache.tsx", import.meta.url)).text();
  const page = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  expect(page).toContain('active={active && selectedSection === "cache"}');
  expect(source).toContain("enabled: active");
  expect(source).toContain("pauseWhenHidden: true");
  expect(source).toContain("pollMs: 15_000");
  expect(source).toContain("/api/claude-code/cache");
  expect(source).not.toContain("expiresAt");
  expect(source).not.toContain("65");
  expect(source).toContain('t("claude.cache.hint")');
});
