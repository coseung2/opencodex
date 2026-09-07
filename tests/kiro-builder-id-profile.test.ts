import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import { KIRO_BUILDER_ID_SERVICE_PROFILE_ARN } from "../src/adapters/kiro-constants";
import { getValidAccessTokenSnapshot } from "../src/oauth";
import { resolveKiroApiRegion, resolveKiroProfileArn, resolveKiroRequestProfileArn } from "../src/oauth/kiro";
import { saveCredential } from "../src/oauth/store";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const origHome = process.env.HOME;
const origLocalAppData = process.env.LOCALAPPDATA;
const origUserProfile = process.env.USERPROFILE;
const origRegion = process.env.KIRO_REGION;
const origApiRegion = process.env.KIRO_API_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

function seedKiroCliBuilderIdSession(): void {
  const dir = process.platform === "win32"
    ? join(tmp, "AppData", "Local", "Kiro-Cli")
    : process.platform === "darwin"
      ? join(tmp, "Library", "Application Support", "kiro-cli")
      : join(tmp, ".local", "share", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [
    "kirocli:social:token",
    JSON.stringify({
      access_token: "local-access",
      refresh_token: "local-refresh",
      region: "us-east-1",
      client_id: "local-client-id",
      client_secret: "local-client-secret",
    }),
  ]);
  db.close();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-builder-id-"));
  process.env.HOME = tmp;
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_PROFILE_ARN;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLocalAppData;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = origApiRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = {
  adapter: "kiro",
  baseUrl: "https://runtime.us-east-1.kiro.dev",
  authMode: "oauth",
  apiKey: "tok-123",
} as unknown as OcxProviderConfig;

function parsedWith(context: OcxParsedRequest["_kiroAuthContext"]): OcxParsedRequest {
  const parsed = {
    modelId: "claude-sonnet-4.5",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
  if (context) parsed._kiroAuthContext = context;
  return parsed;
}

async function buildBody(parsed: OcxParsedRequest): Promise<{
  headers: Record<string, string>;
  payload: { profileArn?: string; conversationState?: Record<string, unknown> };
}> {
  const request = await createKiroAdapter(provider).buildRequest(parsed);
  return { headers: request.headers, payload: JSON.parse(request.body) };
}

describe("kiro Builder ID request-scoped service profile", () => {
  test("Builder ID sends the service profile but stays on the CLI envelope", async () => {
    const { headers, payload } = await buildBody(parsedWith({ apiRegion: "us-east-1", authType: "aws_sso_oidc" }));
    expect(payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(headers["x-amzn-kiro-profile-arn"]).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(headers.accept).toBe("*/*");
    expect(headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
    expect(payload.conversationState?.agentTaskType).toBe("vibe");
  });

  test("enterprise accounts keep their own profile and IDE envelope", async () => {
    const own = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/account-b";
    const { headers, payload } = await buildBody(parsedWith({ apiRegion: "eu-central-1", profileArn: own }));
    expect(payload.profileArn).toBe(own);
    expect(headers["x-amzn-kiro-profile-arn"]).toBe(own);
    expect(headers.accept).toBe("application/vnd.amazon.eventstream");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
  });

  test("an SSO OIDC account that owns a profile never gets the service fallback", async () => {
    const own = "arn:aws:codewhisperer:us-east-1:123456789012:profile/enterprise-sso";
    const { payload } = await buildBody(parsedWith({ authType: "aws_sso_oidc", profileArn: own }));
    expect(payload.profileArn).toBe(own);
  });

  test("desktop accounts and API keys do not borrow the Builder ID profile", async () => {
    const desktop = await buildBody(parsedWith({ apiRegion: "us-east-1", authType: "kiro_desktop" }));
    expect(desktop.payload.profileArn).toBeUndefined();
    expect(desktop.headers["x-amzn-kiro-profile-arn"]).toBeUndefined();

    const apiKeyProvider = { ...provider, authMode: "key", apiKey: "ksk_example" } as unknown as OcxProviderConfig;
    const request = await createKiroAdapter(apiKeyProvider).buildRequest(parsedWith({ authType: "aws_sso_oidc" }));
    expect(JSON.parse(request.body).profileArn).toBeUndefined();
    expect(request.headers["x-amzn-kiro-profile-arn"]).toBeUndefined();
  });

  test("fallback is request-only and never becomes account identity or region", async () => {
    const builderId = { authType: "aws_sso_oidc" as const, ssoRegion: "eu-central-1" };
    expect(resolveKiroProfileArn(builderId)).toBeUndefined();
    expect(resolveKiroRequestProfileArn(builderId)).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(resolveKiroApiRegion(builderId)).toBe("eu-central-1");

    await saveCredential("kiro", {
      access: "stored-access",
      refresh: "stored-refresh",
      expires: Date.now() + 3_600_000,
      source: "local-cli",
      kiro: { ssoRegion: "us-east-1", apiRegion: "us-east-1", clientId: "client-id", clientSecret: "client-secret" },
    });
    const snapshot = await getValidAccessTokenSnapshot("kiro");
    expect(snapshot.kiro?.authType).toBe("aws_sso_oidc");
    expect(snapshot.kiro?.profileArn).toBeUndefined();
    expect((await buildBody(parsedWith({ ...snapshot.kiro }))).payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);

    const stored = readFileSync(join(tmp, "auth.json"), "utf8");
    expect(existsSync(join(tmp, "auth.json"))).toBe(true);
    expect(stored).not.toContain(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(stored).not.toContain("638616132270");
  });

  test("legacy client-pair credentials derive Builder ID without persisting new secrets", async () => {
    await saveCredential("kiro", {
      access: "stored-access",
      refresh: "stored-refresh",
      expires: Date.now() + 3_600_000,
      source: "local-cli",
      kiro: { clientId: "client-id", clientSecret: "client-secret" },
    });
    const snapshot = await getValidAccessTokenSnapshot("kiro");
    expect(snapshot.kiro?.authType).toBe("aws_sso_oidc");
    expect((await buildBody(parsedWith({ ...snapshot.kiro }))).payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
  });

  test("accountless Builder ID imports use the same resolver verdict for profile and envelope", async () => {
    seedKiroCliBuilderIdSession();
    const parsed = parsedWith(undefined);
    const { headers, payload } = await buildBody(parsed);
    expect(payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(headers["x-amzn-kiro-profile-arn"]).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(headers.accept).toBe("*/*");
    expect(headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
  });
});
