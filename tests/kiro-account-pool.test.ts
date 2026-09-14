import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearKiroAccountCooldown,
  clearKiroAccountPoolState,
  getKiroAccountHealthSnapshot,
  resolveKiroAccountForSession,
  rotateKiroAccountOn429,
  rotateKiroAccountOnAuthenticationFailure,
} from "../src/oauth/kiro-routing";
import { getAccountSet, markAccountNeedsReauth, saveCredential, setActiveAccount } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

let home = "";
let previousHome: string | undefined;

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "kiro",
    providers: { kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth" } },
    kiroAccountPool: { enabled: true },
    ...overrides,
  } as OcxConfig;
}

async function seed(): Promise<[string, string]> {
  await saveCredential("kiro", { access: "a", refresh: "ra", expires: Date.now() + 60_000, email: "a@example.com", source: "oauth" });
  const first = getAccountSet("kiro")!.activeAccountId;
  await saveCredential("kiro", { access: "b", refresh: "rb", expires: Date.now() + 60_000, email: "b@example.com", source: "oauth" });
  const second = getAccountSet("kiro")!.activeAccountId;
  await setActiveAccount("kiro", first);
  return [first, second];
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearKiroAccountPoolState();
});

afterEach(() => {
  clearKiroAccountPoolState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Kiro OAuth account pool", () => {
  test("is opt-in and keeps a session on its selected account", async () => {
    const [first, second] = await seed();
    expect(resolveKiroAccountForSession("thread-1", config())).toBe(first);
    await setActiveAccount("kiro", second);
    expect(resolveKiroAccountForSession("thread-1", config())).toBe(first);
    expect(resolveKiroAccountForSession("thread-2", config())).toBe(second);
    expect(resolveKiroAccountForSession("thread-1", config({ kiroAccountPool: { enabled: false } }))).toBe(second);
  });

  test("429 cools down the failed account and moves affinity", async () => {
    const [first, second] = await seed();
    const now = Date.now();
    expect(rotateKiroAccountOn429(config(), first, "2", "thread", now)).toBe(second);
    expect(getKiroAccountHealthSnapshot(first, now)?.cooldownUntil).toBe(now + 2_000);
    expect(resolveKiroAccountForSession("thread", config(), now + 1)).toBe(second);
    expect(clearKiroAccountCooldown(first)).toBe(true);
  });

  test("paused and reauth-required accounts are excluded", async () => {
    const [first, second] = await seed();
    expect(resolveKiroAccountForSession("paused", config({ pausedOauthAccountIds: { kiro: [first] } }))).toBe(second);
    await markAccountNeedsReauth("kiro", second, true);
    expect(resolveKiroAccountForSession("none", config({ pausedOauthAccountIds: { kiro: [first] } }))).toBeNull();
  });

  test("authentication failure marks the account and selects the next", async () => {
    const [first, second] = await seed();
    expect(await rotateKiroAccountOnAuthenticationFailure(config(), first, "thread")).toBe(second);
    expect(getAccountSet("kiro")!.accounts.find(account => account.id === first)?.needsReauth).toBe(true);
    expect(resolveKiroAccountForSession("thread", config())).toBe(second);
  });
});
