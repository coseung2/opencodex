# Remote Notch VM cutover

- Date/timezone: 2026-09-11, Asia/Seoul.
- Symptom: Private-network health worked through the existing loopback listener but management requests returned 403. After private bind and data authentication were enabled, the initial Hermes credential command setting was ignored and its data requests returned 401.
- Impact: Hermes data access was briefly unavailable during cutover validation; existing provider keys and account stores were retained in protected VM backups.
- Cause: Loopback-only OCX intentionally rejects non-loopback management origins. The installed Hermes named-provider compatibility path did not resolve the proposed credential-command setting.
- Response: Bound OCX to its private interface, retained loopback access through a systemd socket proxy, and configured the VM data credential in Hermes's existing protected provider configuration. No public listener was created.
- Verification: Remote management memory returned 200; loopback health succeeded; OCX and Hermes services were active. Hermes's runtime credential resolver matched the VM credential and authenticated `/v1/models` returned 200.
- Follow-up: Validate the actual client credential resolver before service cutover. Browser test tabs were also observed during OAuth tests; those tabs were closed and the server worker was instructed to mock browser opening.
- Final verification: Installed Notch build matched the tested release binary and its process connected to the VM. Credential Manager setup successfully probed remote health and protected memory. Six migrated Codex accounts returned quota without reauthentication flags; Kiro returned quota and an assistant response. Both Responses and Messages requests completed over the private network. Backend full suite and 101 native tests passed, and final flow-status fixes passed focused tests. Browser-opening mocks now prevent synthetic test tabs while retaining local Kiro browser opening.
