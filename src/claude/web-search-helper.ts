/** Claude Code's built-in WebSearch performs a separate small-model Messages
 * request. Match its dedicated prompt AND hosted tool, never arbitrary Claude work. */
export function isClaudeWebSearchHelper(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  const texts = typeof row.system === "string" ? [row.system] : Array.isArray(row.system)
    ? row.system.flatMap(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : []) : [];
  const dedicated = texts.some(text => text.replace(/^x-anthropic-billing-header:[^\n]*\n*/, "").trimStart()
    .startsWith("You are an assistant for performing a web search tool use"));
  return dedicated && Array.isArray(row.tools) && row.tools.some(tool => tool && typeof tool === "object"
    && typeof tool.type === "string" && /^web_search_\d{8}$/.test(tool.type));
}
