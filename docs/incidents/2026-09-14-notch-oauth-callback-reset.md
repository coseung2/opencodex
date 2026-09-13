# Notch OAuth callback connection reset

- Date/timezone: 2026-09-14, Asia/Seoul.
- Symptom: Remote OpenAI reauthentication completed in Chrome, but the redirect to `localhost:1455` displayed `ERR_CONNECTION_RESET` instead of the Notch success page.
- Impact: The browser callback was not automatically relayed to the remote OCX login flow, so reauthentication could remain incomplete.
- Timeline: The active listener was confirmed on both IPv4 and IPv6 loopback. Replaying the callback with a compact HTTP client succeeded. Chrome-shaped large and delayed request headers reproduced relay failures in regression tests. The relay was fixed, the native suite and release build passed, and the installed Notch binary was replaced and restarted.
- Evidence: The relay allowed only 8 KiB of request headers and treated the first 250 ms socket read timeout as terminal despite declaring a one-second absolute request deadline. Chrome may send a larger `localhost` cookie header or split headers across delayed packets.
- Cause: The local callback receiver closed valid browser connections before their complete HTTP headers arrived.
- Response: Increased the bounded header allowance to 64 KiB and continued reading after transient socket timeouts until the existing one-second absolute deadline. Added regression coverage for a Chrome-sized localhost cookie header and delayed header chunks.
- Recovery verification: All 129 native tests passed, including both new callback cases; the optimized release build completed; the installed and built executable SHA-256 hashes match; the restarted Notch process is responsive; and the remote OCX health endpoint returns HTTP 200.
- Prevention: Keep callback parsing bounded by an absolute deadline and maximum size while tolerating normal browser packet fragmentation and shared localhost cookies.
