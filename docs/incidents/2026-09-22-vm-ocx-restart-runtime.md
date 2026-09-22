# VM OCX restart runtime failure

- Date: 2026-09-22 (Asia/Seoul)
- Symptoms: The VM `opencodex-proxy.service` entered a restart loop after the OCX restart attempt; port 10100 returned connection resets instead of health responses.
- Impact: The VM OCX proxy was unavailable while the service was failing. The loopback compatibility listener remained present, but it had no healthy proxy target.
- Timeline: The service was found `enabled` but `activating (auto-restart)` with more than 200 failed starts. The installed package was `2.8.0-cs.33`; the service log repeated `Bun's postinstall script was not run.`. A direct run with `/usr/local/bin/bun` served successfully, after which the user service was reinstalled with that runtime and verified.
- Evidence: The bundled ELF at `node_modules/bun/bin/bun.exe` reported the postinstall error when starting the proxy. `/usr/local/bin/bun` started the same CLI and returned `/healthz` `200` with version `2.8.0-cs.33`. After repair, systemd reported `active (running)`, `enabled`, `Result=success`, `NRestarts=0`; both the VM address and loopback `/healthz` returned `status: ok` after a 12-second stability wait.
- Confirmed cause: The installed service baked a bundled Bun runtime whose npm postinstall setup was incomplete or unusable on the VM. The restart exposed that runtime failure and systemd repeatedly relaunched it.
- Response: Stopped the restart loop, kept the existing service token file out of output, set the approved `OPENCODEX_BUN_PATH` override to `/usr/local/bin/bun`, reinstalled the user service, and verified both listeners and health endpoints.
- Recovery verification: `opencodex-proxy.service` is active and enabled with zero restarts; the process is `/usr/local/bin/bun`; port 10100 listens on the VM address and through the loopback compatibility socket; both health checks return the running OCX version.
- Follow-up: Avoid using unmanaged `ocx restart` semantics for a service-installed VM until the lifecycle behavior is corrected; validate bundled Bun postinstall readiness during package/service installation and retain the system Bun override for this VM.
