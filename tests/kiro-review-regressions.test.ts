import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessTokenSnapshot, OAUTH_PROVIDERS, runLogin } from "../src/oauth";
import {
  inspectKiroCliSessionSnapshot,
  persistKiroCliSessionRecovery,
  readKiroCliSqliteCredential,
  restoreStaleKiroCliSessionRecovery,
} from "../src/oauth/kiro-credentials";
import { getAccountCredential, getAccountSet, saveCredential } from "../src/oauth/store";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";
import type { OcxConfig } from "../src/types";

const ENV_KEYS = [
  "HOME",
  "OPENCODEX_HOME",
  "KIRO_ACCESS_TOKEN",
  "KIRO_REFRESH_TOKEN",
  "KIRO_PROFILE_ARN",
  "KIRO_REGION",
  "KIRO_API_REGION",
  "KIRO_CREDS_FILE",
  "KIRO_CREDENTIALS_FILE",
  "KIRO_CLI_DB_FILE",
  "KIROCLI_DB_PATH",
  "KIROCLI_TOKEN_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
let tmp: string;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {},
  };
}

function kiroCliDbPath(): string {
  return join(tmp, "Library", "Application Support", "kiro-cli", "data.sqlite3");
}

function kiroCliRecoveryPath(): string {
  return `${kiroCliDbPath()}.opencodex-recovery`;
}

function removeKiroCliDb(): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${kiroCliDbPath()}${suffix}`, { force: true });
  }
}

function seedKiroCliDb(access: string, refresh: string): void {
  const path = kiroCliDbPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [
    "kirocli:social:token",
    JSON.stringify({ access_token: access, refresh_token: refresh }),
  ]);
  db.close();
}

function rewriteRecoveryProcessInstance(processInstance: string): void {
  const path = kiroCliRecoveryPath();
  const payload = readFileSync(path);
  const headerEnd = payload.indexOf(0x0a);
  const ownerEnd = payload.indexOf(0x0a, headerEnd + 1);
  const instanceEnd = payload.indexOf(0x0a, ownerEnd + 1);
  if (headerEnd < 0 || ownerEnd < 0 || instanceEnd < 0) throw new Error("unexpected Kiro recovery format");
  expect(Number(payload.subarray(headerEnd + 1, ownerEnd).toString("utf8"))).toBe(process.pid);
  writeFileSync(path, Buffer.concat([
    payload.subarray(0, ownerEnd + 1),
    Buffer.from(`${processInstance}\n`, "utf8"),
    payload.subarray(instanceEnd + 1),
  ]), { mode: 0o600 });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-review-regressions-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "opencodex");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("Kiro review regressions", () => {
  test("environment login keeps explicit request-routing metadata without borrowing local CLI state", async () => {
    process.env.KIRO_ACCESS_TOKEN = "aoa-env";
    process.env.KIRO_REFRESH_TOKEN = "rt-env";
    process.env.KIRO_PROFILE_ARN = "arn:aws:codewhisperer:ap-southeast-2:123456789012:profile/env";
    process.env.KIRO_API_REGION = "eu-west-1";
    process.env.KIRO_REGION = "eu-central-1";

    const credential = await runLogin("kiro", {} as OAuthController, undefined, {
      loadConfig: config,
      saveConfig: () => {},
    });
    const snapshot = await getValidAccessTokenSnapshot("kiro");

    expect(credential).toMatchObject({ access: "aoa-env", refresh: "rt-env", source: "environment" });
    expect(snapshot).toMatchObject({
      accessToken: "aoa-env",
      kiro: {
        profileArn: "arn:aws:codewhisperer:ap-southeast-2:123456789012:profile/env",
        apiRegion: "eu-west-1",
        ssoRegion: "eu-central-1",
      },
    });
  });

  test("Kiro CLI recovery rolls back config persistence failures before settling the account switch", async () => {
    const rawCredential: OAuthCredentials = {
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
      accountId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/new",
      source: "local-cli",
    };
    const events: string[] = [];
    const originalLogin = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => rawCredential;
    try {
      await expect(runLogin("kiro", {} as OAuthController, { forceLogin: true }, {
        saveCredential: async () => { events.push("credential"); },
        loadConfig: () => {
          events.push("load-config");
          return config();
        },
        saveConfig: () => {
          events.push("save-config");
          throw new Error("config write failed");
        },
        settleKiroLoginTransaction: (credential, persisted) => {
          expect(credential).toBe(rawCredential);
          events.push(`settle:${persisted}`);
        },
      })).rejects.toThrow("config write failed");
    } finally {
      OAUTH_PROVIDERS.kiro.login = originalLogin;
    }

    expect(events).toEqual(["credential", "load-config", "save-config", "settle:false"]);
  });

  test("Kiro reauth accepts the same email when the refreshed credential gains a profile ARN", async () => {
    await saveCredential("kiro", {
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() + 60_000,
      email: "same@example.test",
      source: "local-cli",
    });
    const slotId = getAccountSet("kiro")!.activeAccountId;
    const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/same";
    const originalLogin = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => ({
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
      email: "SAME@example.test",
      accountId: profileArn,
      source: "local-cli",
      kiro: { profileArn },
    });
    try {
      await runLogin("kiro", {} as OAuthController, { reauthAccountId: slotId }, {
        loadConfig: config,
        saveConfig: () => {},
      });
    } finally {
      OAUTH_PROVIDERS.kiro.login = originalLogin;
    }

    expect(getAccountSet("kiro")?.accounts).toHaveLength(1);
    expect(getAccountCredential("kiro", slotId)).toMatchObject({
      access: "new-access",
      email: "SAME@example.test",
      accountId: profileArn,
      kiro: { profileArn },
    });
  });

  test("same-PID process restart restores a stale Kiro CLI recovery transaction", () => {
    seedKiroCliDb("aoa-prior", "rt-prior");
    const snapshot = inspectKiroCliSessionSnapshot().snapshot;
    expect(snapshot).not.toBeNull();
    persistKiroCliSessionRecovery(snapshot!);

    removeKiroCliDb();
    seedKiroCliDb("aoa-abandoned", "rt-abandoned");
    rewriteRecoveryProcessInstance("restarted-process-instance");

    expect(restoreStaleKiroCliSessionRecovery()).toBe(true);
    expect(readKiroCliSqliteCredential()).toMatchObject({ access: "aoa-prior", refresh: "rt-prior" });
    expect(existsSync(kiroCliRecoveryPath())).toBe(false);
  });
});
