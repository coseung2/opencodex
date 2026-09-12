# OCX Notch

OCX Notch is a Windows native widget for managing OCX accounts, models, subagents,
usage and request logs. It can use a local OCX or connect Notch and Codex to your own
remote server. Start and Stop control the local OCX only.

## Build and run

Requires a current stable Rust toolchain and Windows 10 or later.

```powershell
cargo build --release
.\target\release\ocx-notch.exe
```

## Install from npm

The published package supports Windows x64 only and bundles the native executable:

```powershell
npm install --global @coseung2/ocx-notch
ocx-notch
```

The npm release workflow uses npm Trusted Publishing (OIDC), so it does not keep a long-lived `NPM_TOKEN`. Because npm requires a package to exist before its trusted publisher can be configured, the package owner must publish `0.1.0` once with npm authentication, then add this GitHub repository and `.github/workflows/release.yml` in the package's Trusted Publisher settings. Later `v*` tags publish automatically.

For OCX 2.8+, local mode automatically reads the existing `%USERPROFILE%\.opencodex\admin-api-token` management credential (or `OPENCODEX_HOME\admin-api-token`). `OPENCODEX_ADMIN_AUTH_TOKEN` remains supported. Remote profiles store their OCX API key in Windows Credential Manager; keys are never displayed, logged, or written to `window.json`.

## Remote setup

These instructions describe the current source in this repository. Use a Notch
build containing remote Codex connection support; if an installed package lacks
the controls below, build this checkout using **Build and run** above.

### 1. Prepare the server

Use your own OCX server, domain and credentials. Oracle Cloud and Tailscale are not
required. The examples below use `ocx.example.com` and an example private backend
address `10.0.0.5`; replace both with your own values.

- Run OCX with its provider accounts configured on the server. Bind the backend to
  a private interface reachable by nginx, for example `10.0.0.5:10100`.
- A non-loopback OCX listener requires data-plane authentication. Configure its
  service with `OPENCODEX_API_AUTH_TOKEN` or a supported configured data key.
- Obtain an OCX API key with at least the `viewer` role. The service's
  `OPENCODEX_ADMIN_AUTH_TOKEN` or protected `~/.opencodex/admin-api-token`
  credential also works for administrators.
- Configure DNS and a trusted TLS certificate for the HTTPS endpoint. Allow its
  exact origin in OCX's `corsAllowOrigins`, such as `https://ocx.example.com`.
- Use a server build exposing `hostCpu` and `hostMemory` in `/api/system/memory`
  for the VM CPU and RAM meters. Older servers display unavailable telemetry.

Keep the service's `OPENCODEX_HOME` and `CODEX_HOME` settings consistent when
running setup commands. The default directories belong to the service account,
not necessarily your SSH login or administrator account.

### 2. Configure HTTPS authentication translation

**This step is required for the current Codex integration regardless of whether
your network is restricted.** Codex's credential command supplies a bearer token;
OCX's Responses API expects its proxy key in `X-OpenCodex-API-Key` and reserves
`Authorization` for upstream authentication. Management-only API access does not
need this translation, but Notch's current Connect action also configures Codex.

Place these maps inside nginx's `http` context, outside any `server` block:

```nginx
map $http_authorization $notch_data_key {
    default $http_x_opencodex_api_key;
    "~^Bearer (ocx_data_[a-f0-9]{40})$" $1;
}
map $http_authorization $notch_upstream_authorization {
    default $http_authorization;
    "~^Bearer ocx_data_[a-f0-9]{40}$" "";
}
```

In your HTTPS virtual host, use the following proxy settings with your real
certificate paths and backend address:

```nginx
server {
    listen 443 ssl;
    server_name ocx.example.com;
    ssl_certificate /etc/letsencrypt/live/ocx.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ocx.example.com/privkey.pem;

    client_max_body_size 64m;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-OpenCodex-API-Key $notch_data_key;
    proxy_set_header Authorization $notch_upstream_authorization;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location = /healthz { proxy_pass http://10.0.0.5:10100; }
    location /api/ { proxy_pass http://10.0.0.5:10100; }
    location /v1/ { proxy_pass http://10.0.0.5:10100; }
    location / { return 404; }
}
```

Run `sudo nginx -t` before reloading nginx. This maps only OCX-generated data
bearers, removes those credentials from upstream Authorization, and preserves
other Authorization values. OCX still validates every data key and independently
authenticates management requests. Do not replace this with an authentication bypass.

### 3. Prepare the Codex model catalog

The server's authenticated `GET /api/catalog` must return a nonempty Codex catalog.
Run `ocx sync` under the OCX service account and environment to synchronize the
server's provider visibility and subagent selections.

If the server has no Codex installation and reports `catalog not found`, export the
native template from the Codex version on the connecting PC:

```powershell
codex debug models --bundled > native-models.json
```

Transfer that template to the server. For a default installation with no existing
catalog, place it at the service account's `~/.codex/opencodex-catalog.json`, creating
the directory if needed, and run `ocx sync` there. Honor a custom `CODEX_HOME` or
`model_catalog_json` path instead when configured. Preserve an existing catalog.
Use the native template, not another PC's already-customized OCX catalog: routed
providers and enabled models must come from the server's own configuration.

### 4. Connect from Windows

Use a Codex version supporting `model_providers.<id>.auth.command`.

1. Launch Notch, right-click it, and open **연결 설정…** (Connection settings).
2. Select **원격 서버** (Remote server).
3. Enter your server origin, such as `https://ocx.example.com`, without `/v1`,
   `/api`, query parameters, or a token in the URL.
4. Enter an OCX API key with at least the `viewer` role and click **접속**
   (Connect). The legacy server management token remains supported. When
   reconnecting to the same saved address, leave the field empty to reuse the
   saved credential.
5. Fully close and reopen Codex. Start a new conversation if an existing thread
   retains its previous provider. Confirm that a new request appears in the VM's logs.

Connect detects the key's effective permissions, downloads the server catalog,
and checks Responses authentication before saving Codex routing. A `viewer` or
`operator` key is reused directly because it cannot mint credentials. An admin
key or legacy management token creates or reuses a client-specific data key.
Credentials live in Windows Credential Manager. Codex retrieves its key through
Notch's credential command; no token is written into `config.toml`.

Notch updates `CODEX_HOME/config.toml` (normally `%USERPROFILE%\.codex\config.toml`)
and uses the `ocx-notch` provider with the downloaded `ocx-notch-catalog.json`.
It preserves unrelated settings and saves `config.toml.before-notch` before the
first change. Active Codex profiles and multiline TOML strings require manual
configuration; Notch reports these instead of rewriting them. Conversation history
is not migrated, and Claude or other clients are not automatically reconfigured.

### Connect, disconnect, and local mode

| Action | Effect |
| --- | --- |
| **접속** (Connect) | Configures Notch and Codex for the selected server. Restart existing Codex sessions. |
| **접속 끊기** (Disconnect) | Revokes this client's Codex data key and stops Notch polling. The VM keeps running; no automatic local fallback occurs. |
| **로컬 PC → 접속** (Local PC → Connect) | Explicitly points Notch and Codex at `127.0.0.1:10100`. Saved remote server information remains available. Restart Codex after switching. |

Disconnect needs server contact to confirm revocation for a client-specific key.
A directly entered API key remains on the server and is removed only from this
PC. A failure is shown as an error, and a request already accepted by the server
may finish. Each Windows user has their own credential vault; issue `viewer`
keys to people who need Notch read access without server mutation rights.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Could not reach OCX | DNS, trusted TLS certificate, HTTPS listener, and proxy-to-backend connectivity. |
| OCX API key rejected | Use a key with at least `viewer` access. A data-plane-only `user` key cannot populate Notch. Check the allowed HTTPS origin. |
| Header-translation error or Responses 401 | Apply both nginx maps and both authentication headers above. A successful `/v1/models` request alone does not prove Responses authentication works. |
| `catalog not found` | Complete catalog setup under the server service's account and environment. |
| VM logs remain old while local logs advance | An existing Codex process or thread is still using local OCX. Fully restart Codex and use a new conversation; verify a fresh VM log entry. |
| Model choices remain old in Codex | Notch refreshes the downloaded catalog after visibility and subagent changes, but an existing Codex process can retain its in-memory list. Restart Codex. |
| VM CPU shows `—` | Allow two telemetry samples. Check server connectivity and support for the host CPU fields. It never substitutes this PC's CPU usage. |

See also the [remote connection reference](../../docs-site/src/content/docs/guides/remote-notch.md).

## Data and polling

- Remote Connect configures both Notch and Codex, storing the separate Codex data key in Windows Credential Manager. Codex uses `--codex-token <origin>` through command-backed provider auth and the VM catalog. Restart existing Codex sessions after switching. Disconnect revokes this client's key and suspends polling; Local PC is an explicit action. `--reconnect` and `--disconnect` expose the same actions for automation.
- In remote mode, `/api/system/memory` polls independently every ~3 seconds. The header's VM CPU segmented meter uses deltas of cumulative host CPU counters; missing or reset counters show no percentage until two valid samples arrive. The lower segmented meter displays VM physical memory usage. No local CPU measurement is substituted.

- `/healthz` supplies the OCX PID and online status every ~30 seconds.
- Windows `OpenProcess` + `K32GetProcessMemoryInfo` samples working set and private commit every ~2 seconds. The header shows each value on a fixed segmented capacity gauge: Private Max is current private commit plus remaining system commit headroom, and WS Max is current working set plus available physical RAM. Filled ticks show the current share and dim ticks show remaining capacity. Private commit is emphasized because it is the useful leak signal. This does not call the expensive OCX memory endpoint.
- The same native sample collects `GetPerformanceInfo` physical total/available and commit total/limit values. The header labels the smaller available headroom as `안정`, `주의`, or `위험`; caution and danger use 10%/2 GiB and 5%/1 GiB minimum-headroom thresholds respectively. No memory history is persisted.
- `/api/usage?range=7d` refreshes around every 30 seconds; only the newest calendar day's model rows are aggregated into the displayed per-provider usage.
- `/api/logs?tail=10` refreshes every ~2 seconds only while the Logs tab is visible. The response replaces the in-memory list, newest first, and OCX Notch never persists logs itself.
- `/api/models` and `/api/selected-models` load the model catalog grouped by configured provider. The Models tab uses the dashboard's effective visibility rules and writes each on/off change through `/api/model-visibility` to control what OCX and Codex expose.
- `/api/subagent-models`, `/api/injection-model`, and `/api/v2` load the central OCX subagent roster, delegation defaults, and multi-agent mode. Saving the Subagents tab writes these settings back to that same OCX instance, including when Notch uses a remote connection profile.
- Model visibility changes immediately reload the Subagents choices without waiting for account polling. Unsaved selections and defaults are preserved when still available; hidden models are removed from the draft.
- OpenAI account state and per-account quotas refresh around every 5 seconds. Other provider configuration, account pools, and cached `/api/provider-quotas` refresh around every 5 minutes. For xAI OAuth, OCX reports the authoritative weekly Grok credit-pool usage and reset; the separate monthly spending cap is not presented as quota.
- Provider setup reads OCX's `/api/provider-presets` catalog on demand. OAuth status is polled only while a browser/device sign-in or account reauthentication is active; device authorization URLs, instructions, and user codes remain visible in the modal.
- OAuth account pools request per-account quotas, so Kiro and other supported accounts show their own remaining quota bars.
- `/api/system/memory` is requested only while expanded, at most every ~45 seconds, for optional heap detail.

All HTTP calls use WinHTTP against the active local or remote OCX endpoint. There is no WebView, database, persistent usage history, runtime download, or automatic startup behavior. The last window position and width are stored in `%LOCALAPPDATA%\OCX Notch\window.json`.

Startup failures and Rust panics are written to the bounded diagnostic log `%LOCALAPPDATA%\OCX Notch\ocx-notch.log`. Running `ocx-notch` while the widget is already open restores its opacity, repaints it, and moves it to the top of the monitor containing the cursor. Display-topology changes also clamp the window back into a visible work area.

## Interaction

- Click the small copy icon beside an authorization URL to copy the full URL. A green check confirms the copy.
- Click the power control to run `ocx stop` while OCX is online or `ocx start` while it is offline. The control stays busy until the command finishes; health polling determines the resulting online/offline state.
- Online shutdown uses OCX's authenticated `POST /api/stop` graceful-stop endpoint directly, with CLI fallback for older OCX versions. Power transitions probe health immediately and then every ~75ms with a short timeout so the control reflects the real listener state quickly.
- The header keeps Private and WS on separate rows, with fixed 0-to-Max segmented gauges beside them. The unboxed power and minus controls retain generous invisible hit areas and show hover/pressed feedback.
- Click the notch to expand provider details.
- Use the inline Providers, Logs, Models, and Subagents tabs below the memory header to switch content. Logs show only the latest 10 requests with status, output tok/s, relative time, reasoning effort, Fast state, and token usage. Estimated rates are prefixed with `~`; unavailable rates use an em dash.
- In Models, switch each configured provider model on or off in the central OCX/Codex catalog. Native OpenAI rows follow the shared disabled-model setting, while routed rows also follow the provider's selected-model allowlist.
- In Subagents, select up to five featured models from the enabled catalog, move them up or down to set their advertised order, and choose the preferred delegation model and reasoning effort. The same page controls multi-agent guidance, whether the delegation choice is synchronized into Codex defaults, and the connected OCX server's V1/default/V2 subagent mode. **Save changes** applies the settings to the connected OCX server; mode changes apply to new sessions, and clearing the preferred model also clears its effort and Codex-default synchronization.
- When expanded, click the top-right minus control to collapse back to the 58px notch.
- Drag either side edge to resize the notch width. Position and width are restored on the next launch.
- Drag anywhere on the notch to move it; its chosen position is preserved while it expands, collapses, or refreshes.
- Click a provider with multiple accounts to expand or collapse its account rows.
- Click **삭제** on a Codex, OAuth, or API-key account row and confirm to remove it from the pool. The main Codex account is excluded. A failed deletion keeps the row and displays an error.
- Click the pause icon beside an OpenAI account to exclude it from the rotation pool. A paused account shows a play icon that includes it again. The icon updates immediately and rolls back if OCX rejects the request.
- OpenAI accounts with reset credits show the same compact ticket badge used by the dashboard beside the pause/play control. Click it to open an in-app modal with every ticket's grant and expiry dates; OCX identifies the FIFO next ticket, confirms consumption in the modal, and refreshes the displayed count after a successful reset.
- Accounts that require renewed credentials expose an inline **재인증** action on the same row. OpenAI's main account is intentionally excluded; eligible OpenAI pool and generic OAuth accounts can start, cancel, and retry browser authentication.
- Adding Kiro opens a native account-type choice. Personal login keeps the existing forced fresh-account flow through the local Kiro CLI; organization login accepts an IAM Identity Center `https://*.awsapps.com/start` URL and AWS region, and OCX then runs AWS SSO OIDC device authorization itself, without the local Kiro CLI or its session. The verification page AWS returns opens in the browser (commonly the portal's own `/start/#/device?user_code=...` address rather than a `device.sso` host) and the one-time user code is shown on the notch for manual approval, in the same cancellable flow; on success the account joins the Kiro pool under a composite user-plus-organization identity, with the chosen AWS region kept per account as `ssoRegion` for later token refresh while the typed Start URL is not stored.
- Providers with quota data are shown first. Configured providers without quota data remain visible with their usage and account controls.
- Press **Esc** to collapse.
- Right-click to add a provider, set the real OCX account rotation threshold, fine-tune it by 1%, **Refresh**, or **Exit**. The opaque provider modal groups supported presets into Account, Free, and Paid tabs. Canonical OpenAI adds another Codex account, OAuth presets use browser/device authorization, and required-key presets use masked API-key entry. Fixed-endpoint key-optional presets (including OpenCode Free and MiMo Free) accept an empty key; entering a key instead adds a distinct account slot to OCX's existing key pool, which can be switched from the provider row. Ollama, vLLM, and LM Studio use local auth without a key. Cloudflare Workers AI also appears in Free and asks for its Account ID before creating the provider. Endpoint-choice and other unresolved placeholder-URL presets remain omitted because this compact modal cannot preserve those setup contracts safely. `Off` writes threshold `0`.

Quota percentages are shown as used percentages with 5-hour/weekly/monthly/custom-window columns in one compact row, reset countdowns, 5px progress bars, green fill, and the green-to-amber threshold warning used by the OCX dashboard. Columns are derived from whichever quota windows the management API returns, so provider-specific windows appear without a plan-name list in the notch. Provider usage is merged by exact provider name, limited to the newest day, and formatted with Korean `만/억/조` units. OpenAI account rows show their own 5-hour/weekly/monthly quotas; OAuth and key-pool rows show their masked identity and active/health state, while provider-level quota remains associated with the active account. The native window uses a subtle 238/255 global alpha.

For OpenCode Go, the collapsed header keeps the provider report's 5-hour/weekly/monthly windows rather than copying a monthly-only key row, and each expanded key row shows that key's own 5-hour/weekly/monthly allocation.
