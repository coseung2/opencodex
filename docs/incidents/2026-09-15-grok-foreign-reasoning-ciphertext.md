# Grok foreign reasoning ciphertext rejection

- Date/timezone: 2026-09-15, Asia/Seoul (UTC+09:00).
- Status: remediation released as `2.8.0-cs.29`; production deployment in progress.

## Symptoms and impact

Switching an existing Responses conversation from another provider to `xai/grok-4.6` returned HTTP 400 with `invalid-argument` and `Could not decrypt the provided encrypted_content`. Two affected production requests at 10:43:54 and 10:51:46 KST ended in 0.679 and 0.312 seconds. Codex continued to show Working without a useful answer, which also made a newly opened client session appear stalled.

## Evidence and cause

The request history contained a reasoning item with provider-private `encrypted_content` minted by a different backend. The proxy forwarded that ciphertext because route provenance may be unavailable after a client session transition or proxy restart. xAI cannot decrypt another backend's ciphertext and rejected the request before streaming began.

Production `2.8.0-cs.28` remained healthy. Five nearby Grok requests completed normally, with first output in 1.1–4.3 seconds and an upstream terminal in 9–12 seconds. This confirms that the prior terminal-aware relay repair is active and distinguishes this incident from a stream that remains open after `response.completed`.

## Response and recovery checks

The Responses passthrough now preserves reasoning ciphertext on the first attempt. If the outbound request carried reasoning ciphertext and the upstream decoder returns the specific xAI or OpenAI invalid-encrypted-content error, the proxy removes only reasoning `encrypted_content` and retries once. Unrelated 4xx responses are not retried, and normal same-provider continuation remains unchanged.

Focused adapter tests (47), xAI streaming tests (5), type checking, privacy scanning, `git diff --check`, and the full 511-file test suite passed with no failures. Production recovery will be verified after deployment with the health/version endpoint and a real Grok request that reaches an upstream terminal.

## Follow-up

Keep the retry bounded and error-specific. Request logs should retain the privacy-safe recovery kind so future occurrences can be distinguished from provider latency and terminal-relay failures without recording ciphertext or prompts.
