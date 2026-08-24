import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearLoginState,
  getLoginStatus,
  getValidAccessToken,
  OAuthLoginRequiredError,
  OAuthProviderPublicationError,
  OAuthTokenRefreshBusyError,
  OAuthTokenRefreshStaleError,
  OAUTH_PROVIDERS,
  publicOAuthAuthenticationErrorMessage,
  UnsupportedOAuthProviderError,
} from "../src/oauth";
import { OAuthMutationBusyError, saveCredential } from "../src/oauth/store";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

const TEST_DIR = join(import.meta.dir, `.tmp-oauth-status-privacy-test-${process.pid}`);
const PUBLIC_OAUTH_ERROR = "OAuth authentication failed. Check the OpenCodex account status and retry.";
const PUBLIC_ERROR_CANARY = "C:\\Users\\Alice\\.opencodex\\auth.json.ocx-tmp \\\\server\\share\\auth.json /home/alice/.opencodex/auth.json";
let previousOpencodexHome: string | undefined;

describe("OAuth status privacy", () => {
  beforeEach(() => {
    clearLoginState("xai");
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    clearLoginState("xai");
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("getLoginStatus returns a masked provider email", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "person@example.test",
      accountId: "acct-xai",
      source: "local-cli",
    });

    const status = getLoginStatus("xai");

    expect(status.loggedIn).toBe(true);
    expect(status.email).toBe("p***n@example.test");
    expect(status.source).toBe("local-cli");
    expect(JSON.stringify(status)).not.toContain("person@example.test");
    expect(JSON.stringify(status)).not.toContain("access-token");
    expect(JSON.stringify(status)).not.toContain("refresh-token");
  });

  test("saveCredential persists only the credential allowlist", async () => {
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      legacy: {
        access: "legacy-access",
        refresh: "legacy-refresh",
        expires: Date.now() + 60_000,
        source: "attacker-controlled-source",
        prompt: "legacy prompt",
        headers: { authorization: "Bearer legacy" },
      },
    }), "utf8");

    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "person@example.test",
      accountId: "acct-xai",
      source: "credential-file",
      prompt: "secret prompt",
      headers: { authorization: "Bearer leaked" },
      idToken: "jwt-secret",
    } as never);

    const stored = readFileSync(join(TEST_DIR, "auth.json"), "utf8");

    expect(stored).toContain("access-token");
    expect(stored).toContain("refresh-token");
    expect(stored).toContain("legacy-access");
    expect(stored).toContain("\"source\": \"credential-file\"");
    expect(stored).not.toContain("attacker-controlled-source");
    expect(stored).not.toContain("legacy prompt");
    expect(stored).not.toContain("Bearer legacy");
    expect(stored).not.toContain("secret prompt");
    expect(stored).not.toContain("Bearer leaked");
    expect(stored).not.toContain("jwt-secret");
  });

  test("getLoginStatus ignores invalid legacy source metadata", async () => {
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      xai: {
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        source: "oauth<script>",
      },
    }), "utf8");

    const status = getLoginStatus("xai");

    expect(status.loggedIn).toBe(true);
    expect(status.source).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("oauth<script>");
  });

  test("stale credentials for removed OAuth providers fail as unsupported provider config", async () => {
    await saveCredential("removed-provider", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });

    await expect(getValidAccessToken("removed-provider")).rejects.toBeInstanceOf(UnsupportedOAuthProviderError);
  });

  test("malformed oauth token store is backed up before a new credential save overwrites it", async () => {
    const authPath = join(TEST_DIR, "auth.json");
    writeFileSync(authPath, "{not valid json", "utf8");

    await saveCredential("xai", {
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
    });

    const backups = readdirSync(TEST_DIR).filter(name => name.startsWith("auth.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(TEST_DIR, backups[0]), "utf8")).toBe("{not valid json");
  });

  test("public OAuth errors preserve only the fixed operational allowlist", () => {
    expect(publicOAuthAuthenticationErrorMessage(new Error(PUBLIC_ERROR_CANARY))).toBe(PUBLIC_OAUTH_ERROR);
    expect(publicOAuthAuthenticationErrorMessage(new OAuthLoginRequiredError("xai"))).toBe(
      "Not logged in to xai. Run: ocx login xai",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthLoginRequiredError(PUBLIC_ERROR_CANARY)))
      .toBe(PUBLIC_OAUTH_ERROR);
    expect(publicOAuthAuthenticationErrorMessage(new OAuthProviderPublicationError())).toBe(
      "OAuth credential was saved, but the provider entry was not written. Resolve the account namespace collision, then retry login.",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthTokenRefreshBusyError())).toBe(
      "OAuth token refresh capacity reached",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthTokenRefreshStaleError())).toBe(
      "OAuth token refresh owner became stale",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthMutationBusyError())).toBe("OAuth mutation queue is busy");
    expect(publicOAuthAuthenticationErrorMessage(new OAuthMutationBusyError("OAuth mutation queue wait timed out")))
      .toBe("OAuth mutation queue wait timed out");
    expect(publicOAuthAuthenticationErrorMessage(new OAuthMutationBusyError(PUBLIC_ERROR_CANARY)))
      .toBe("OAuth mutation queue is busy");
  });

  test("management OAuth login does not return raw provider or filesystem errors", async () => {
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async () => {
      throw new Error(`provider login failed at ${PUBLIC_ERROR_CANARY}`);
    };
    try {
      const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
      const request = new ManagementRequest("http://localhost/api/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai" }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), config);
      const body = await response?.json() as { error?: string };
      expect(response?.status).toBe(409);
      expect(body.error).toBe(PUBLIC_OAUTH_ERROR);
      expect(JSON.stringify(body)).not.toContain(PUBLIC_ERROR_CANARY);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("management OAuth status does not return late provider or filesystem errors", async () => {
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async controller => {
      controller.onAuth({ url: "https://auth.example.test/authorize" });
      throw new Error(`late provider login failure at ${PUBLIC_ERROR_CANARY}`);
    };
    try {
      const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
      const startRequest = new ManagementRequest("http://localhost/api/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai" }),
      });
      expect((await handleManagementAPI(startRequest, new URL(startRequest.url), config))?.status).toBe(200);

      const deadline = Date.now() + 2_000;
      let statusBody: { done?: boolean; error?: string } = {};
      do {
        const statusRequest = new ManagementRequest("http://localhost/api/oauth/status?provider=xai");
        const statusResponse = await handleManagementAPI(statusRequest, new URL(statusRequest.url), config);
        expect(statusResponse?.status).toBe(200);
        statusBody = await statusResponse?.json() as typeof statusBody;
        if (!statusBody.done) await Bun.sleep(10);
      } while (!statusBody.done && Date.now() < deadline);

      expect(statusBody.done).toBe(true);
      expect(statusBody.error).toBe(PUBLIC_OAUTH_ERROR);
      expect(JSON.stringify(statusBody)).not.toContain(PUBLIC_ERROR_CANARY);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

});
