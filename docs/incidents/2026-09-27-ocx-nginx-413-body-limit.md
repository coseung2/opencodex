# OCX vhost rejected large Responses bodies with 413

- Date/timezone: 2026-09-27, Asia/Seoul.
- Symptoms: A client POST to `https://ocx.aura-board.com/v1/responses` failed with
  `413 Request Entity Too Large` and an `nginx/1.24.0 (Ubuntu)` body page plus a
  `cf-ray` header, so the request was rejected behind Cloudflare but before OCX.
- Impact: Every request body over 64 MiB was refused at the origin reverse proxy;
  large Codex turns could not run through the public endpoint at all.
- Timeline: `client_max_body_size 64m;` was present in the vhost since the remote
  Notch cutover. It was reproduced on 2026-09-27 with a 70 MiB POST (413) and a
  32 MiB POST (admitted, answered `401` from OCX), then raised to `100m`.
- Evidence: 70 MiB body -> nginx 413 after ~1.1 MB uploaded; 32 MiB body -> reached
  OCX and returned its JSON `invalid_api_key` error. OCX's own ceiling is 256 MiB
  (`MAX_DECOMPRESSED_BODY_BYTES`, `tests/server-request-body-size.test.ts`). A
  `Content-Length` probe of 104,857,600 bytes passed the edge and reached OCX, while
  105,000,000 bytes returned Cloudflare's own `413 Payload Too Large` page.
- Cause: The immediate origin nginx cap was 64 MiB, below both OCX's 256 MiB
  application limit and the payloads real Codex turns produce. The transport design
  also has a second hard ceiling: Remote Notch injects the custom `ocx-notch` model
  provider at the Cloudflare-proxied HTTPS origin, while Codex request compression is
  enabled only for its built-in OpenAI provider. Large remote turns therefore cross
  Cloudflare as uncompressed JSON and remain subject to the zone's upload limit even
  after nginx is raised. nginx also spooled request bodies to disk before forwarding
  them.
- Response: Raised the vhost to `client_max_body_size 100m;`, added
  `proxy_request_buffering off;` so large bodies stream to OCX, and moved the stale
  duplicate `sites-enabled/ocx.aura-board.com.bak-20260912-130806` (loaded by nginx
  alongside the active file since 2026-09-12) into `sites-available`. `nginx -t`
  passed and nginx was reloaded; the previous config is preserved at
  `/etc/nginx/sites-available/ocx.aura-board.com.bak-20260927-105314`.
- Recovery verification: `/healthz` returns 200 for `2.8.0-cs.34`; the same 70 MiB
  POST now reaches OCX; an authenticated `GET /v1/models` returns 200; a live
  `POST /v1/responses` (`opencode-free/space-bunny-free`) completed with the expected
  text. `opencodex-proxy.service` (user scope, `Linger=yes`) and `ocx-loopback.socket`
  are active with `MainPID=145595`.
- Prevention: Make the private Tailscale endpoint the preferred Codex Responses data
  path for enrolled clients and retain the Cloudflare hostname for management, health,
  and fallback traffic. The private endpoint is already authenticated with a separate
  data key and was verified from the Windows client with authenticated `GET /v1/models`
  over `100.120.114.62:10100`; it bypasses Cloudflare's body and write-time limits while
  preserving OCX's 256 MiB decompressed-body guard. A future Notch connection profile
  should carry separate `managementOrigin` and `dataOrigin` values, inject the private
  data origin into Codex, probe it before activation, and fall back to the public origin
  only for requests below a conservative edge threshold. For clients without Tailscale,
  use a dedicated DNS-only TLS data hostname with firewall allowlisting or upgrade the
  Cloudflare zone; never expose raw port 10100 publicly. To address payload growth as
  well as the network ceiling, add explicit zstd compression support for custom Codex
  Responses providers when Codex exposes it. Until then, the fully controlled design is
  a small local Notch data relay: Codex keeps its built-in OpenAI provider and points
  `openai_base_url` at loopback (retaining native request compression and compaction),
  while the relay reads the client data key from Windows Credential Manager, injects
  the admission header, and forwards over Tailscale. The relay should route to the
  Cloudflare fallback only when its compressed `Content-Length` is below a safety
  margin, and otherwise return a local structured error requesting compaction. Also
  keep one enabled nginx vhost file per hostname and retain
  `proxy_request_buffering off` on HTTP fallback.
