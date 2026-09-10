import { describe, expect, test } from "bun:test";
import { OAuthCallbackFlow } from "../src/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";

class TestFlow extends OAuthCallbackFlow {
  async generateAuthUrl(): Promise<{ url: string }> {
    return { url: "https://example.test/auth" };
  }

  async exchangeToken(): Promise<OAuthCredentials> {
    return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
  }
}

const ctrl: OAuthController = {};

describe("OAuth callback server defaults", () => {
  test("binds callback listeners to numeric loopback by default", () => {
    const flow = new TestFlow(ctrl, 54545, "/callback");

    expect(flow.callbackHostname).toBe("localhost");
    expect(flow.callbackBindHostname).toBe("127.0.0.1");
  });

  test("keeps explicit callback bind hostname overrides", () => {
    const flow = new TestFlow(ctrl, {
      preferredPort: 54545,
      callbackPath: "/callback",
      callbackHostname: "localhost",
      callbackBindHostname: "127.0.0.1",
    });

    expect(flow.callbackBindHostname).toBe("127.0.0.1");
  });
});

test("client-browser OAuth advertises its callback without binding the VM port", async () => {
  let auth: { callbackUri?: string } | undefined;
  let manualState: string | undefined;
  class RemoteFlow extends OAuthCallbackFlow {
    constructor() {
      super({
        clientBrowser: true,
        onAuth: info => { auth = info; },
        onManualCodeInput: async expectedState => {
          manualState = expectedState;
          return `http://127.0.0.1:45678/exact/callback?code=remote-code&state=${expectedState}`;
        },
      }, {
        preferredPort: 45678,
        callbackPath: "/exact/callback",
        callbackHostname: "127.0.0.1",
        callbackBindHostname: "127.0.0.1",
        redirectUri: "http://127.0.0.1:45678/exact/callback",
      });
    }
    async generateAuthUrl() { return { url: "https://example.test/authorize" }; }
    async exchangeToken(code: string) {
      return { access: code, refresh: "refresh", expires: Date.now() + 60_000 };
    }
  }

  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 45678, fetch: () => new Response("occupied") });
  try {
    const credential = await new RemoteFlow().login();
    expect(credential.access).toBe("remote-code");
    expect(manualState).toBeTruthy();
    expect(auth?.callbackUri).toBe("http://127.0.0.1:45678/exact/callback");
  } finally {
    blocker.stop(true);
  }
});
