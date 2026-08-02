---
title: Installation
description: Install the opencodex (ocx) proxy, its prerequisites, and verify it runs.
---

`@coseung2/opencodex` installs two equivalent proxy command names, `ocx` and `opencodex`, plus the
Windows x64 companion command `ocx-notch`. The proxy commands launch the same small local HTTP
server (built on Bun). Model requests go to the provider selected by routing; optional vision and
web-search sidecars can also use your ChatGPT login when a routed model needs them.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` runs on the Bun runtime, but the runtime is bundled automatically on `npm install` — you do **not** need to install Bun yourself. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App, or SDK) | The client opencodex sits in front of. opencodex writes to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). |
| A provider account or API key | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, an OpenAI-compatible endpoint, or your ChatGPT login. |

## Install

```bash
npm install -g @coseung2/opencodex@next
```

:::note[npm blocked the bun postinstall?]
Recent npm versions may block bun's postinstall script (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
which leaves the bundled Bun runtime unprepared. Reinstall allowing bun's
script — and always include the package name (npm's abbreviated suggestion
omits it, which would reinstall the current directory instead):

```bash
npm install -g --allow-scripts=bun @coseung2/opencodex@next

# if the original install used sudo, keep using sudo:
sudo npm install -g --allow-scripts=bun @coseung2/opencodex@next
```
:::

Verify the proxy command aliases are on your `PATH`:

```bash
ocx --version
opencodex --version
```

On Windows x64, `ocx-notch` launches the native Notch companion bundled in the same npm package.
On Linux, macOS, and non-x64 Windows systems, that command exits with an explicit unsupported-platform
message; `ocx` and `opencodex` remain fully supported.

### Release channels

The coseung2 fork starts on the `next` channel with `2.8.0-cs.*` versions. Keep fork installations
on that channel until a stable fork release is explicitly promoted. The upstream `preview` channel
is not the release channel for this package:

```bash
npm install -g @coseung2/opencodex@next
ocx update --tag next
```

## Run from source

To hack on opencodex itself:

```bash
git clone https://github.com/coseung2/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # starts the proxy API in dev mode (src/cli/index.ts start)
bun run dev:gui     # starts the dashboard dev server (another terminal)
```

`bun run dev` remains an alias for `bun run dev:proxy`. The proxy API exposes `/healthz`,
`/v1/responses`, and `/api/*`; `GET /` serves the packaged dashboard only after `bun run build:gui`
has produced `gui/dist`. While hacking on the dashboard, run the frontend separately with
`bun run dev:gui`.

## What gets created

opencodex state lives under `$OPENCODEX_HOME` (default `~/.opencodex`). Codex integration files live
under `$CODEX_HOME` (default `~/.codex`).

| Path | Purpose |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Your providers, default provider, port, and options. |
| `$OPENCODEX_HOME/ocx.pid` | PID of the running proxy (single-instance guard). |
| `$OPENCODEX_HOME/runtime-port.json` | The live PID, hostname, and port, including an automatically selected fallback port. |
| `$OPENCODEX_HOME/auth.json` | Stored OAuth credentials (when you `ocx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Codex model catalog backups made before opencodex edits it. |
| `$CODEX_HOME/config.toml` | On loopback, opencodex adds a marker-owned root `openai_base_url`; non-loopback binds use `model_provider = "opencodex"` plus `[model_providers.opencodex]` so Codex can send the API-auth header. |
| `$CODEX_HOME/opencodex.config.toml` | Fallback/reference profile written alongside the main Codex config. |
| `$CODEX_HOME/opencodex-catalog.json` | Synced native and routed model catalog used by Codex. |

:::note
opencodex never deletes your Codex config. Every injection is reversible — `ocx stop`, `ocx restore`,
or `ocx eject` strip exactly the lines opencodex added and restore native Codex.
:::

## Next

Continue to the [Quickstart](/getting-started/quickstart/) to configure your first provider,
or read [How It Works](/getting-started/how-it-works/) for the architecture.
