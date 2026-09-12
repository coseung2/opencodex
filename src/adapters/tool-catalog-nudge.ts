import {
  isAllowedToolChoice,
  namespacedToolName,
  toolAllowedByChoice,
  toolChoiceAliases,
  type OcxRequestOptions,
  type OcxTool,
  type OcxProviderConfig,
} from "../types";

import { CODE_MODE_HOST_CONTRACT_SENTENCE, CODE_MODE_RESULT_ECHO_SENTENCE } from "./exec-tool-result-normalize";

/** A name alone cannot distinguish a JavaScript isolate from an ordinary shell tool. */
export function isCodexCodeModeExecTool(tool: Pick<OcxTool, "namespace" | "name" | "freeform">): boolean {
  return !tool.namespace && tool.name === "exec" && tool.freeform === true;
}

export function isBareShellBridgeTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return !tool.namespace && (tool.name === "exec_command" || tool.name === "shell_command");
}

const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS", "apply_patch"] as const;

function quoteNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(", ");
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => name.trim().length > 0))];
}

function toolChoiceAllows(tool: Pick<OcxTool, "namespace" | "name">, toolChoice: OcxRequestOptions["toolChoice"] | undefined): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  if (isAllowedToolChoice(toolChoice)) return toolAllowedByChoice(tool, new Set(toolChoice.allowedTools));
  return toolChoiceAliases(tool).includes(toolChoice.name);
}

function isOpenAIOrChatGPTHost(hostname: string): boolean {
  return hostname === "openai.com"
    || hostname.endsWith(".openai.com")
    || hostname === "chatgpt.com"
    || hostname.endsWith(".chatgpt.com");
}

export function shouldInjectNonOpenAIToolCatalogNudge(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    return !isOpenAIOrChatGPTHost(new URL(provider.baseUrl).hostname);
  } catch {
    return true;
  }
}

export function buildNonOpenAIToolCatalogNudgeFromNames(
  wireNames: readonly string[] | undefined,
  toWireName: (name: string) => string = name => name,
  codeModeExecName?: string,
): string | undefined {
  const names = uniqueNames(wireNames ?? []);
  if (names.length === 0) return undefined;

  const advertised = new Set(names);
  const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(name => !advertised.has(name) && !advertised.has(toWireName(name)));
  const verifiedCodeMode = codeModeExecName && advertised.has(codeModeExecName);

  return [
    "Tool contract: use the current tool catalog as ground truth.",
    `Valid tool names for this turn are exactly ${quoteNames(names)}.`,
    "Call only listed names with their listed argument keys; do not invent, translate, or rename tools.",
    verifiedCodeMode
      ? `\`${codeModeExecName}\` is Codex code mode: its body is JavaScript evaluated in a V8 isolate. The listed names are the top-level call surface, not the list of nested helpers. Call nested helpers inside exec as await tools.<name>(...). Deferred helpers remain callable even when absent from the top-level catalog or a truncated description; discover them via the isolate global ALL_TOOLS, not tools.ALL_TOOLS. ${CODE_MODE_RESULT_ECHO_SENTENCE} ${CODE_MODE_HOST_CONTRACT_SENTENCE}`
      : undefined,
    unavailableNeighborNames.length > 0
      ? `Do not use neighboring-agent tool names ${quoteNames(unavailableNeighborNames)} unless this turn's catalog lists those exact names.`
      : undefined,
    "If you need shell, file search, file read, edit, or discovery behavior, choose the listed tool that provides that capability.",
    "Count a tool call only after its tool result returns; batch independent read-only calls when the runtime supports it.",
  ].filter((line): line is string => typeof line === "string").join(" ");
}

export function buildNonOpenAIToolCatalogNudgeForTools(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
  toWireName: (tool: Pick<OcxTool, "namespace" | "name">) => string = tool => namespacedToolName(tool.namespace, tool.name),
): string | undefined {
  const visibleNames = tools
    ?.filter(tool => toolChoiceAllows(tool, toolChoice))
    .map(toWireName);
  return buildNonOpenAIToolCatalogNudgeFromNames(visibleNames);
}
