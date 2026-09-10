# Remote Notch and central OCX migration

## Accepted product contract

- Local mode remains the default with existing controls.
- Remote mode connects each Windows Notch to the existing testauram OCX through the private network.
- Remote mode has no Start, Stop, or Restart actions, including menu and fallback paths. It shows server memory and connection status; loss of connection triggers reconnection, never a local process launch.
- Provider keys, account credentials, pool state, and runtime configuration live on the VM. Each PC stores only its protected management credential and nonsecret connection address.
- Local browsers handle user interaction. VM generates and retains state/PKCE, exchanges tokens, and stores credentials. Notch relays the complete callback URL through the authenticated management API.
- Kiro organization device login works remotely; the CLI-dependent personal flow is unavailable remotely until separately implemented.

## Interfaces

- Login requests add `clientBrowser: true`; local callers retain existing behavior.
- Remote login responses return `flowId`, `url`, optional `callbackUri`, and optional display-only `deviceCode` (user code, never device secret).
- Remote code submission, status and cancellation identify the originating flow. A conflicting generic provider login may return 409; it must never cancel another client's attempt.
- The Notch listener binds only the specified loopback URI before opening the browser. Port collision, expiry and cancellation close the flow clearly. The server validates callback state and consumes each callback once.
- Transport snapshots connection credentials per operation, does not forward credentials on redirects, and does not fall back to local credentials.
- Remote memory uses `/api/system/memory`; no local `OpenProcess` against VM PIDs.

## Work ownership

- Server worker: browser ownership, callback descriptors, scoped relay/status/cancel and tests.
- Transport worker: connection persistence, protected secret, WinHTTP endpoint handling and tests.
- Native UI worker: connection modal, power/memory behavior, browser/callback relay and tests.
- Parent: interface integration, credential migration, independent review, source/build/runtime checks.

## Migration procedure

1. Inspect source and destination schema and counts without displaying secrets. Discover actual service user and storage root.
2. Create protected recoverable backups on both machines; transfer only allowlisted provider configuration and credential stores over SSH.
3. Preserve destination listeners, management/data credentials, Hermes routing and existing accounts. Resolve environment references only for provider-specific values. Do not copy Windows paths, process state, logs, caches, or native DBs.
4. Merge accounts by authenticated identity and key pools by actual key. Retain destination credentials for conflicts until freshness can be assessed; do not overwrite an entire VM store with the PC snapshot.
5. Validate the merged result and runtime source closure before restart. Bind to the private interface or provide a private proxy while preserving Hermes loopback access.
6. Test VM account visibility, token validity and representative provider requests, then connect Notch. Preserve local recovery data and avoid simultaneous refresh ownership after cutover.

## Acceptance

Two clients must see one central pool; remote authentication opens the initiating PC's browser; callback replay or wrong-flow submission fails; remote mode cannot execute power commands; keys are absent from plaintext UI state; disconnected remote mode is explicit. Migration evidence must distinguish inventory, transferred credentials, verified accounts, and completed client cutover.

## Implemented and verified

- Native connection settings, Credential Manager storage, remote power refusal, server memory and local callback relay are implemented. Native suite: 101 passed; release binary built and installed.
- Server remote login descriptors, scoped callbacks/status/cancel and browser ownership are implemented. Full backend suite passed; final focused relay/status tests passed after an expired-flow error correction.
- Existing VM accounts and provider keys were preserved during migration. Six distinct Codex accounts were added from seven source rows; all six returned quota without a reauthentication flag. Migrated Kiro quota and model response were verified; xAI and Antigravity accounts were present.
- Private management memory returned 200. The running installed Notch was observed connecting to the VM. Codex Responses and Claude Messages requests completed successfully through the VM.
- Codex/Claude client configuration was backed up and changed to the VM endpoint; already-running clients may retain their existing connection until restarted.
- Remote OpenAI authorization start and flow-specific cancellation were verified live without browser approval. Callback relay has real TCP tests; a complete human-approved remote browser login and interactive Notch visual inspection remain unverified.
- VM's private listener and authenticated loopback compatibility relay preserve Hermes; Hermes credential resolution and authenticated model listing were verified after restart.
