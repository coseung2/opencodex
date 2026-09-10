import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderCatalog from "../src/components/provider-catalog/ProviderCatalog";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
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
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

test("a logged-in OAuth provider starts a fresh add-account login", async () => {
  const calls: Array<[provider: string, addAccount?: boolean]> = [];
  const { createRoot } = await import("react-dom/client");

  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderCatalog
          presets={[]}
          initialTier="accounts"
          onSelectPreset={() => {}}
          onSelectCustom={() => {}}
          accountRows={[{ id: "kiro", label: "Kiro", kind: "oauth" }]}
          accountStatus={{ kiro: { loggedIn: true, email: "member@example.com" } }}
          onLogin={(provider, addAccount) => calls.push([provider, addAccount])}
          onLogout={() => {}}
        />
      </LanguageProvider>,
    );
  });

  const addButton = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Add account");
  expect(addButton).toBeTruthy();
  expect(host.textContent).toContain("member@example.com");

  await act(async () => {
    addButton?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  });

  expect(calls).toEqual([["kiro", true]]);
});

test("a Kiro add-account device flow shows the matching code and browser URL", async () => {
  const { createRoot } = await import("react-dom/client");

  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderCatalog
          presets={[]}
          initialTier="accounts"
          onSelectPreset={() => {}}
          onSelectCustom={() => {}}
          accountRows={[{ id: "kiro", label: "Kiro", kind: "oauth" }]}
          accountStatus={{ kiro: { loggedIn: true, email: "member@example.com" } }}
          busyProvider="kiro"
          loginHint={{
            provider: "kiro",
            deviceCode: "ABCD-EFGH",
            url: "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH",
          }}
          onLogin={() => {}}
          onCancelLogin={() => {}}
          onLogout={() => {}}
        />
      </LanguageProvider>,
    );
  });

  expect(host.textContent).toContain("ABCD-EFGH");
  expect(host.textContent).toContain("Waiting for browser");
  const authLink = host.querySelector<HTMLAnchorElement>(".login-url-block-open");
  expect(authLink?.href).toBe("https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH");
});
