/**
 * Heuristic token-estimation sidecar.
 *
 * Some providers (notably Kiro / CodeWhisperer) do not reliably return token usage for every
 * stream, so usage display and context-pressure handling need a cheap local estimate. The generic
 * ratios remain conservative and provider-neutral; Kiro-specific measurements are applied only to
 * `kiro` / `kiro/...` ids so the same Claude/DeepSeek/Qwen families on other providers are not
 * silently retuned.
 */

/** Generic English-prose fallback ratio (chars per token). */
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Kiro routes code/JSON-heavy agent traffic. Recorded Kiro conversations put pure-Latin content at
 * about 2.8 chars/token, materially denser than ordinary English prose. Keep this Kiro-scoped: the
 * same model family on Anthropic, Cursor, or another gateway has a different wire/framing cost.
 */
const KIRO_CHARS_PER_TOKEN = 2.8;

/** Existing non-Kiro agent-family heuristic retained for backwards compatibility. */
const AGENT_MODEL_CHARS_PER_TOKEN = 3.5;
const AGENT_MODEL_PREFIXES = ["kiro", "claude", "deepseek", "minimax", "glm", "qwen"];

/** Model-aware LATIN chars-per-token ratio. */
export function charsPerToken(modelId?: string): number {
  if (!modelId) return DEFAULT_CHARS_PER_TOKEN;
  const id = modelId.toLowerCase();
  // `estimateKiroTokens` deliberately prefixes the routed id with `kiro/`.
  if (id.startsWith("kiro")) return KIRO_CHARS_PER_TOKEN;
  if (AGENT_MODEL_PREFIXES.some(prefix => id.startsWith(prefix))) return AGENT_MODEL_CHARS_PER_TOKEN;
  return DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Hangul/Han/Kana tokenizes markedly denser than Latin text. Apply the dense ratio only to the
 * characters that need it instead of switching the whole payload at an arbitrary CJK-share
 * threshold. This removes both the old 30% cliff and the stride-sampling alias on long payloads.
 */
const CJK_CHARS_PER_TOKEN = 1.5;

/** Exact, allocation-free BMP CJK count. Rare supplementary-plane characters are safely overcounted. */
function countCjk(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0x1100 && code <= 0x11ff)
      || (code >= 0x3130 && code <= 0x318f)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3040 && code <= 0x30ff)
    ) cjk += 1;
  }
  return cjk;
}

/**
 * Estimate the token count of a text blob. Pure and deterministic.
 * Returns 0 for empty input; otherwise at least 1.
 */
export function estimateTokens(text: string, modelId?: string): number {
  if (!text) return 0;
  const length = text.length;
  if (length === 0) return 0;
  const latinRatio = charsPerToken(modelId);
  const cjk = countCjk(text);
  const estimate = cjk === 0
    ? Math.ceil(length / latinRatio)
    : Math.ceil((length - cjk) / latinRatio + cjk / CJK_CHARS_PER_TOKEN);
  return Math.max(1, estimate);
}
