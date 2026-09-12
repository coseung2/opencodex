# VM deployment shell quoting failure

- Date/timezone: 2026-09-12, Asia/Seoul.
- Symptom: The first VM deployment command failed before installation because PowerShell evaluated shell substitutions intended for the remote Bash process. A later transferred script completed its deployment work but exited nonzero on a trailing carriage return.
- Impact: The first attempt copied the package archive but did not change the installed runtime. The successful second attempt reported a misleading final failure after the package had already been installed and the service restarted.
- Timeline: The inline SSH command failed, the existing service was confirmed active on its original process, and deployment was retried with a transferred script. Installation and restart completed, after which the script reached an extra carriage-return line and exited nonzero.
- Evidence: The first attempt left the original service process and health response unchanged. After the transferred script ran, `opencodex-proxy.service` was active on a new process with zero restarts, `/healthz` returned success, and the installed Grok namespace compatibility source hash matched the validated local source.
- Cause: The inline command crossed PowerShell and Bash quoting boundaries without protecting remote command substitutions. The transferred script also retained Windows CRLF at its final line.
- Response: Replaced the inline command with a script executed entirely by remote Bash, normalized subsequent transferred scripts to LF, and verified deployment state independently of the script exit code.
- Recovery verification: The VM served the fixed runtime on port 10100. A real Grok Responses request flattened the namespace tool for xAI and restored the completed function call as `namespace: mcp__workspace`, `name: read_file`, with the requested `README.md` argument.
- Prevention: Use LF-normalized script files for multi-step remote deployments from Windows, avoid nested shell interpolation in inline SSH commands, and verify service process, health, installed source hash, and behavior after every deployment.
