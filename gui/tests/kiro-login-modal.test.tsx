import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import KiroLoginModal, { type KiroOrganizationLogin } from "../src/components/KiroLoginModal";
import { LanguageProvider } from "../src/i18n/provider";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM?.close?.();
});

async function renderModal(props: { onCancel?: () => void; onSubmit?: (organization?: KiroOrganizationLogin) => void } = {}) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <KiroLoginModal onCancel={props.onCancel ?? (() => {})} onSubmit={props.onSubmit ?? (() => {})} />
      </LanguageProvider>,
    );
  });
}

function click(text: string) {
  const button = Array.from(host.querySelectorAll("button, label")).find(node => node.textContent?.includes(text));
  expect(button).toBeTruthy();
  button?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}

function setInput(input: HTMLInputElement | undefined, value: string) {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

test("offers personal login by default and submits without organization details", async () => {
  const submissions: Array<KiroOrganizationLogin | undefined> = [];
  await renderModal({ onSubmit: organization => submissions.push(organization) });

  expect(host.textContent).toContain("Personal account");
  expect(host.textContent).toContain("Organization account");
  expect(host.querySelector("input[type='url']")).toBeNull();

  await act(async () => { click("Continue"); });
  expect(submissions).toEqual([undefined]);
});

test("requires organization fields and submits canonical organization details", async () => {
  const submissions: Array<KiroOrganizationLogin | undefined> = [];
  await renderModal({ onSubmit: organization => submissions.push(organization) });

  await act(async () => { click("Organization account"); });
  const startUrl = host.querySelector<HTMLInputElement>("input[type='url']");
  const region = Array.from(host.querySelectorAll<HTMLInputElement>("input")).find(input => input.placeholder === "us-east-1");
  expect(startUrl?.required).toBe(true);
  expect(region?.required).toBe(true);

  await act(async () => {
    setInput(startUrl ?? undefined, "https://TEAM.awsapps.com/start");
    setInput(region, " us-west-2 ");
  });
  await act(async () => { click("Continue"); });

  expect(submissions).toEqual([{ startUrl: "https://team.awsapps.com/start", region: "us-west-2" }]);
});

test("rejects a non-canonical organization URL", async () => {
  const submissions: Array<KiroOrganizationLogin | undefined> = [];
  await renderModal({ onSubmit: organization => submissions.push(organization) });
  await act(async () => { click("Organization account"); });
  const inputs = host.querySelectorAll<HTMLInputElement>("input");
  const startUrl = Array.from(inputs).find(input => input.type === "url");
  const region = Array.from(inputs).find(input => input.placeholder === "us-east-1");
  await act(async () => {
    setInput(startUrl, "https://example.com/start");
    setInput(region, "us-east-1");
  });
  await act(async () => { click("Continue"); });
  expect(submissions).toEqual([]);
  expect(host.textContent).toContain("canonical awsapps.com/start URL");
});

test("cancel clears transient fields before the modal is reopened", async () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return open
      ? <KiroLoginModal onCancel={() => setOpen(false)} onSubmit={() => {}} />
      : <button type="button" onClick={() => setOpen(true)}>Reopen</button>;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  await act(async () => { click("Organization account"); });
  const startUrl = host.querySelector<HTMLInputElement>("input[type='url']");
  await act(async () => {
    setInput(startUrl ?? undefined, "https://team.awsapps.com/start");
    click("Cancel");
  });
  await act(async () => { click("Reopen"); });
  expect(host.querySelector("input[type='url']")).toBeNull();
  expect(host.querySelector<HTMLInputElement>("input[value='personal']")?.checked).toBe(true);
});

test("OAuth request bodies preserve personal, organization, and other-provider contracts", async () => {
  const bodies: unknown[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return await new Promise<Response>(() => {});
    },
  });

  function Harness() {
    const aliveRef = useRef(true);
    const generationRef = useRef(new Map<string, number>());
    const oauth = useProvidersOAuth({
      apiBase: "",
      t: ((key: string) => key) as never,
      aliveRef,
      oauthLoginGenerationRef: generationRef,
      accountSets: {},
      setBusy: () => {}, setStatus: () => {}, setLoginInfo: () => {}, setOauthStatus: () => {},
      notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {},
      fetchAccountSets: async () => {}, fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {},
    });
    return (
      <>
        <button onClick={() => void oauth.loginOAuth("kiro", true)}>Personal</button>
        <button onClick={() => void oauth.loginOAuth("kiro", true, undefined, { startUrl: "https://team.awsapps.com/start", region: "us-west-2" })}>Organization</button>
        <button onClick={() => void oauth.loginOAuth("claude", true)}>Other</button>
      </>
    );
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness />);
  });
  await act(async () => { click("Personal"); click("Organization"); click("Other"); });

  expect(bodies).toEqual([
    { provider: "kiro", addAccount: true },
    { provider: "kiro", addAccount: true, kiroOrganization: { startUrl: "https://team.awsapps.com/start", region: "us-west-2" } },
    { provider: "claude", addAccount: true },
  ]);
});

test("unmount cancels an in-progress Kiro organization login", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith("/api/oauth/login/cancel")) return Response.json({ ok: true, cancelled: true });
      return await new Promise<Response>(() => {});
    },
  });

  function Harness() {
    const aliveRef = useRef(true);
    const generationRef = useRef(new Map<string, number>());
    const oauth = useProvidersOAuth({
      apiBase: "",
      t: ((key: string) => key) as never,
      aliveRef,
      oauthLoginGenerationRef: generationRef,
      accountSets: {},
      setBusy: () => {}, setStatus: () => {}, setLoginInfo: () => {}, setOauthStatus: () => {},
      notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {},
      fetchAccountSets: async () => {}, fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {},
    });
    return <button onClick={() => void oauth.loginOAuth("kiro", true, undefined, {
      startUrl: "https://team.awsapps.com/start",
      region: "us-west-2",
    })}>Start</button>;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness />);
  });
  await act(async () => { click("Start"); });
  await act(async () => { root?.unmount(); root = undefined; });
  await act(async () => { await Promise.resolve(); });

  expect(requests).toContainEqual({
    path: "/api/oauth/login/cancel",
    body: { provider: "kiro" },
  });
});
