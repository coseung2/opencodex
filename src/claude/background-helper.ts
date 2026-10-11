/** Conservative recognition of tool-free native Haiku helpers. Do not remap
 * arbitrary conversations, safety classifiers or user-assigned worker models. */
export function claudeBackgroundHelperKind(body: unknown): "web-fetch" | "title" | "tool-summary" | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const row = body as Record<string, unknown>;
  if (typeof row.model !== "string" || !/^claude-(?:3-5-)?haiku(?:-|$)/.test(row.model)) return;
  if (row.tools !== undefined && (!Array.isArray(row.tools) || row.tools.length > 0)) return;
  const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
  const system = text(row.system).replace(/^x-anthropic-billing-header:[^\n]*\n*/, "").trim();
  if (system.startsWith("You are a security monitor") || /permission|security classifier/i.test(system)) return;
  const messages = Array.isArray(row.messages) ? row.messages : [];
  if (messages.length !== 1 || messages[0]?.role !== "user") return;
  const prompt = text(messages[0].content).trim();
  if (prompt.startsWith("Web page content:") && prompt.includes("---")
    && /Provide a concise response based (?:only )?on the content above\./.test(prompt)) return "web-fetch";
  if (system.startsWith("Write a short summary label describing what these tool calls accomplished.")
    && prompt.includes("Tools completed:") && prompt.endsWith("Label:")) return "tool-summary";
  if (prompt.startsWith("<session>") && prompt.includes("</session>")
    && system.includes('Return JSON with a single "title" field.')) return "title";
}
