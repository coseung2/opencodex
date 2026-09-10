import { describe, expect, test } from "bun:test";
import { loginKiroOrganizationDevice, type KiroDeviceLoginDependencies } from "../src/oauth/kiro-device";

const organization = {
  startUrl: "https://example.awsapps.com/start",
  region: "us-east-1",
};

type Step = { status?: number; body: Record<string, unknown>; headers?: Record<string, string> };

function fixture(steps: Step[], sleeps: number[] = []) {
  const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  let now = 1_000;
  const deps: KiroDeviceLoginDependencies = {
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    fetch: (async (input, init) => {
      const step = steps.shift();
      if (!step) throw new Error("unexpected request");
      requests.push({
        url: String(input),
        init,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
      });
      return new Response(JSON.stringify(step.body), {
        status: step.status ?? 200,
        headers: step.headers,
      });
    }) as typeof fetch,
  };
  return { deps, requests };
}

const registration = { clientId: "client-id", clientSecret: "client-secret" };
const authorization = {
  deviceCode: "private-device-code",
  userCode: "ABCD-EFGH",
  verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
  verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
  expiresIn: 120,
  interval: 2,
};
const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/organization";
const profile = { body: { profiles: [{ arn: profileArn }] } };
const token = { accessToken: "access-secret", refreshToken: "refresh-secret", expiresIn: 60 };
function successSteps(userId = "user-123"): Step[] {
  return [
    { body: registration },
    { body: authorization },
    { body: token },
    { body: { userInfo: { userId, email: "USER@Example.com" } } },
    profile,
  ];
}

describe("Kiro direct organization device login", () => {
  test('organization login refuses missing or ambiguous profiles instead of using a personal fallback', async () => {
    for (const profiles of [[], [{arn:profileArn},{arn:profileArn+'2'}]]) {
      const steps=successSteps();
      steps[steps.length-1]={body:{profiles}};
      await expect(loginKiroOrganizationDevice({},organization,fixture(steps).deps)).rejects.toThrow(/unambiguous organization profile/);
    }
  });
  test("registers, authorizes, polls, and resolves stable per-user identity", async () => {
    const sleeps: number[] = [];
    const { deps, requests } = fixture(successSteps(), sleeps);
    const auth: Array<{ url: string; deviceCode?: string }> = [];

    const credential = await loginKiroOrganizationDevice(
      { onAuth: value => auth.push(value) },
      organization,
      deps,
    );

    expect(requests.map(request => request.url)).toEqual([
      "https://oidc.us-east-1.amazonaws.com/client/register",
      "https://oidc.us-east-1.amazonaws.com/device_authorization",
      "https://oidc.us-east-1.amazonaws.com/token",
      "https://q.us-east-1.amazonaws.com/getUsageLimits?origin=KIRO_CLI&resourceType=AGENTIC_REQUEST&isEmailRequired=true",
      "https://q.us-east-1.amazonaws.com/ListAvailableProfiles",
    ]);
    expect(requests[0]?.body).toEqual({
      clientName: "OpenCodex",
      clientType: "public",
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      scopes: [
        "codewhisperer:completions",
        "codewhisperer:analysis",
        "codewhisperer:conversations",
      ],
    });
    expect(requests[2]?.body).toMatchObject({ deviceCode: "private-device-code" });
    expect(requests[3]?.init?.method).toBe("GET");
    expect(requests[3]?.body).toEqual({});
    expect(requests.every(request => request.init?.redirect === "manual")).toBe(true);
    expect(auth).toEqual([{
      url: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
      deviceCode: "ABCD-EFGH",
      instructions: "Open the AWS verification page and confirm the displayed code.",
    }]);
    expect(sleeps).toEqual([2_000]);
    expect(credential).toMatchObject({
      access: "access-secret",
      refresh: "refresh-secret",
      accountId: "user-123",
      email: "user@example.com",
      source: "oauth",
      kiro: {
        authType: "aws_sso_oidc",
        ssoRegion: "us-east-1",
        apiRegion: "us-east-1",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
    });
  });

  test("pending and slow_down adjust bounded polling intervals", async () => {
    const sleeps: number[] = [];
    const { deps } = fixture([
      { body: registration },
      { body: { ...authorization, interval: 1 } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { body: token },
      { body: { userInfo: { userId: "pending-user", email: "pending@example.com" } } },
      profile,
    ], sleeps);

    await loginKiroOrganizationDevice({}, organization, deps);

    expect(sleeps).toEqual([1_000, 1_000, 6_000]);
  });

  test("cancels while waiting without another token request", async () => {
    const controller = new AbortController();
    const { deps, requests } = fixture([
      { body: registration },
      { body: authorization },
    ]);
    deps.sleep = async () => {
      controller.abort();
      throw new Error("Kiro login cancelled.");
    };

    await expect(loginKiroOrganizationDevice({ signal: controller.signal }, organization, deps))
      .rejects.toThrow("Kiro login cancelled.");
    expect(requests).toHaveLength(2);
  });

  test("expires at the server deadline and the 300 second controller bound", async () => {
    for (const expiresIn of [1, 600]) {
      const sleeps: number[] = [];
      const { deps, requests } = fixture([
        { body: registration },
        { body: { ...authorization, expiresIn, interval: expiresIn === 1 ? 2 : 301 } },
      ], sleeps);
      await expect(loginKiroOrganizationDevice({}, organization, deps))
        .rejects.toThrow("Kiro device authorization expired.");
      expect(requests).toHaveLength(2);
      expect(sleeps).toEqual([]);
    }
  });

  test("rejects cross-region verification URLs and redirects before onAuth", async () => {
    for (const step of [
      { body: { ...authorization, verificationUri: "https://device.sso.eu-west-1.amazonaws.com/" } },
      { body: { ...authorization, verificationUriComplete: "https://evil.test/?user_code=ABCD-EFGH" } },
      { body: { ...authorization, verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234" } },
      { status: 302, body: {}, headers: { Location: "https://evil.test/?token=secret" } },
    ]) {
      const { deps } = fixture([{ body: registration }, step]);
      let authCalls = 0;
      await expect(loginKiroOrganizationDevice({ onAuth: () => { authCalls += 1; } }, organization, deps))
        .rejects.toThrow();
      expect(authCalls).toBe(0);
    }
  });

  test("accepts the exact organization portal device fragment returned by AWS", async () => {
    const portalAuthorization = {
      ...authorization,
      verificationUri: "https://example.awsapps.com/start/#/device",
      verificationUriComplete: "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH",
    };
    const { deps } = fixture([
      { body: registration },
      { body: portalAuthorization },
      { body: token },
      { body: { userInfo: { userId: "portal-user" } } },
      profile,
    ]);
    const auth: Array<{ url: string; deviceCode?: string }> = [];
    await loginKiroOrganizationDevice({ onAuth: value => auth.push(value) }, organization, deps);
    expect(auth).toEqual([{
      url: portalAuthorization.verificationUriComplete,
      deviceCode: "ABCD-EFGH",
      instructions: "Open the AWS verification page and confirm the displayed code.",
    }]);
  });

  test("redacts untrusted OAuth errors and all credentials", async () => {
    const leaked = ["access-secret", "refresh-secret", "client-secret", "private-device-code"];
    const { deps } = fixture([
      { body: registration },
      { body: authorization },
      { status: 400, body: { error: "server_secret", error_description: leaked.join(" ") } },
    ]);
    let message = "";
    try {
      await loginKiroOrganizationDevice({}, organization, deps);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Kiro token request failed (400).");
    for (const secret of leaked) expect(message).not.toContain(secret);
  });

  test("bounds chunked service responses before JSON parsing", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.close();
      },
    });
    const deps: KiroDeviceLoginDependencies = {
      fetch: (async () => new Response(oversized, { status: 200 })) as typeof fetch,
    };

    await expect(loginKiroOrganizationDevice({}, organization, deps))
      .rejects.toThrow("Kiro login service returned an invalid response.");
  });

  test("uses userInfo.userId so users sharing one profile remain distinct", async () => {
    const first = fixture(successSteps("user-a"));
    const second = fixture(successSteps("user-b"));
    const [a, b] = await Promise.all([
      loginKiroOrganizationDevice({}, organization, first.deps),
      loginKiroOrganizationDevice({}, organization, second.deps),
    ]);
    expect(a.kiro?.profileArn).toBe(profileArn);
    expect(b.kiro?.profileArn).toBe(profileArn);
    expect(a.accountId).toBe("user-a");
    expect(b.accountId).toBe("user-b");
  });
});
