# OCX Notch

OCX Notch is a small Windows-only native status widget for an OpenCodex (OCX) management service. Its power control can start or stop OCX; its other configuration write is an explicit user-selected OpenAI account rotation threshold.

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

For OCX 2.8+, the notch automatically reads the existing `%USERPROFILE%\.opencodex\admin-api-token` management credential (or `OPENCODEX_HOME\admin-api-token`). `OPENCODEX_ADMIN_AUTH_TOKEN` and the legacy `OPENCODEX_API_AUTH_TOKEN` environment variables remain supported. Tokens are used for local requests only and are never displayed, logged, or copied.

## Data and polling

- `/healthz` supplies the OCX PID and online status every ~30 seconds.
- Windows `OpenProcess` + `K32GetProcessMemoryInfo` samples working set and private commit every ~2 seconds. The header shows each value on a fixed segmented capacity gauge: Private Max is current private commit plus remaining system commit headroom, and WS Max is current working set plus available physical RAM. Filled ticks show the current share and dim ticks show remaining capacity. Private commit is emphasized because it is the useful leak signal. This does not call the expensive OCX memory endpoint.
- The same native sample collects `GetPerformanceInfo` physical total/available and commit total/limit values. The header labels the smaller available headroom as `안정`, `주의`, or `위험`; caution and danger use 10%/2 GiB and 5%/1 GiB minimum-headroom thresholds respectively. No memory history is persisted.
- `/api/usage?range=7d` refreshes around every 30 seconds; only the newest calendar day's model rows are aggregated into the displayed per-provider usage.
- `/api/logs?tail=10` refreshes every ~2 seconds only while the Logs tab is visible. The response replaces the in-memory list, newest first, and OCX Notch never persists logs itself.
- OpenAI account state and per-account quotas refresh around every 5 seconds. Other provider configuration, account pools, and cached `/api/provider-quotas` refresh around every 5 minutes.
- `/api/system/memory` is requested only while expanded, at most every ~45 seconds, for optional heap detail.

All HTTP calls use WinHTTP against `127.0.0.1:10100`. There is no WebView, database, log file, runtime download, or automatic startup behavior. The last window position and width are stored in `%LOCALAPPDATA%\OCX Notch\window.json`.

## Interaction

- Click the power control to run `ocx stop` while OCX is online or `ocx start` while it is offline. The control stays busy until the command finishes; health polling determines the resulting online/offline state.
- Online shutdown uses OCX's authenticated `POST /api/stop` graceful-stop endpoint directly, with CLI fallback for older OCX versions. Power transitions probe health immediately and then every ~75ms with a short timeout so the control reflects the real listener state quickly.
- The header keeps Private and WS on separate rows, with fixed 0-to-Max segmented gauges beside them. The unboxed power and minus controls retain generous invisible hit areas and show hover/pressed feedback.
- Click the notch to expand provider details.
- Use the inline Providers and Logs tabs below the memory header to switch content. Logs show only the latest 10 requests with status, duration, relative time, reasoning effort, Fast state, and token usage.
- When expanded, click the top-right minus control to collapse back to the 58px notch.
- Drag either side edge to resize the notch width. Position and width are restored on the next launch.
- Drag anywhere on the notch to move it; its chosen position is preserved while it expands, collapses, or refreshes.
- Click a provider with multiple accounts to expand or collapse its account rows.
- Click the pause icon beside an OpenAI account to exclude it from the rotation pool. A paused account shows a play icon that includes it again. The icon updates immediately and rolls back if OCX rejects the request.
- Providers with quota data are shown first. Providers with usage but no quota stay behind the inline usage-only toggle.
- Press **Esc** to collapse.
- Right-click to set the real OCX account rotation threshold, fine-tune it by 1%, **Refresh**, or **Exit**. `Off` writes threshold `0`.

Quota percentages are shown as used percentages with the same 5-hour/weekly/monthly/custom-window rows, reset countdowns, 5px progress bars, green fill, and green-to-amber threshold warning used by the OCX dashboard. Provider usage is merged by exact provider name, limited to the newest day, and formatted with Korean `만/억/조` units. OpenAI account rows show their own weekly/monthly quotas; OAuth and key-pool rows show their masked identity and active/health state, while provider-level quota remains associated with the active account. The native window uses a subtle 238/255 global alpha.
