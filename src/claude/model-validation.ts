const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Claude Code 2.1.295's side-query probe; ordinary turns must never take this short path. */
export function isClaudeModelValidationProbe(body: unknown): boolean {
  if (!record(body) || body.max_tokens !== 1 || body.stream === true
    || body.thinking !== undefined || body.tool_choice !== undefined
    || body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)
    || !Array.isArray(body.messages) || body.messages.length !== 1) return false;
  const message = body.messages[0];
  if (!record(message) || message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) return false;
  const block = message.content[0];
  return record(block) && block.type === "text" && block.text === "Hi"
    && record(block.cache_control) && block.cache_control.type === "ephemeral";
}
