# Kiro local install restart mismatch

- Date: 2026-09-11 (Asia/Seoul)
- Symptoms: The local OCX restart failed twice with missing-module errors after the Kiro organization-account build was copied into the installed package.
- Impact: The local proxy was briefly stopped during the intended restart. No account login or credential mutation was attempted.
- Timeline: The scoped runtime and GUI files were installed, the first restart exposed an unrelated module dependency mismatch, and a cleanup attempt removed two compatibility modules that the installed runtime still imported. The modules were restored and OCX was started again.
- Evidence: Startup reported missing `opencode-go-pool`, then missing `responses-tool-compat`. The recovered process passed `/healthz` on port 10100 with a new PID, and the installed GUI served the new Kiro organization-account asset.
- Confirmed cause: The local installation backup/copy list did not include the compatibility modules referenced by the installed response adapter, so the attempted scoped rollback left an incomplete runtime module set.
- Response: Restored the installed response core, copied the referenced compatibility modules, restarted OCX, and verified the running Notch binary against the release-build SHA-256.
- Recovery verification: OCX is healthy on port 10100, the installed GUI asset contains the `kiroOrganization` contract, and the running Notch executable matches the release build.
- Follow-up: Treat imported local modules as part of the deployment closure and include them in the backup/copy manifest before restarting an installed development package.
