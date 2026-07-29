# OCX Notch

OCX Notch is a small Windows-only native status widget for a running OpenCodex (OCX) management service. It never starts or stops OCX. Its only configuration write is an explicit user-selected OpenAI account rotation threshold.

## Build and run

Requires a current stable Rust toolchain and Windows 10 or later.

```powershell
cargo build --release
.\target\release\ocx-notch.exe
```

If the OCX management API is protected, set `OPENCODEX_API_AUTH_TOKEN` in the launching process environment. The token is read for requests only; it is never displayed, logged, or persisted.

## Data and polling

- `/healthz` supplies the OCX PID and online status every ~30 seconds.
- Windows `OpenProcess` + `K32GetProcessMemoryInfo` samples working set and private commit every ~2 seconds. Private commit is emphasized because it is the useful leak signal. This does not call the expensive OCX memory endpoint.
- `/api/usage?range=7d` refreshes around every 30 seconds; only the newest calendar day's model rows are aggregated into the displayed per-provider usage.
- Provider configuration, account pools, and cached `/api/provider-quotas` refresh around every 5 minutes, sequentially and without a quota refresh query.
- `/api/system/memory` is requested only while expanded, at most every ~45 seconds, for optional heap detail.

All HTTP calls use WinHTTP against `127.0.0.1:10100`. There is no WebView, database, log file, runtime download, or automatic startup behavior.

## Interaction

- Click the notch to expand provider details.
- Drag anywhere on the notch to move it; its chosen position is preserved while it expands, collapses, or refreshes.
- Click a provider with multiple accounts to expand or collapse its account rows.
- Providers with quota data are shown first. Providers with usage but no quota stay behind the inline usage-only toggle.
- Press **Esc** to collapse.
- Right-click to set the real OCX account rotation threshold, fine-tune it by 1%, **Refresh**, or **Exit**. `Off` writes threshold `0`.

Quota percentages are shown as used percentages with the same 5-hour/weekly/monthly/custom-window rows, reset countdowns, 5px progress bars, green fill, and green-to-amber threshold warning used by the OCX dashboard. Provider usage is merged by exact provider name, limited to the newest day, and formatted with Korean `만/억/조` units. OpenAI account rows show their own weekly/monthly quotas; OAuth and key-pool rows show their masked identity and active/health state, while provider-level quota remains associated with the active account. The native window uses a subtle 238/255 global alpha.
