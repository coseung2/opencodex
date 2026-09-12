import { hasRecordedTrailingDeliveredFinalAnswer } from "../responses/turn-termination";
import type { OcxAssistantMessage, OcxMessage, OcxParsedRequest } from "../types";
import {
  KIRO_COMPLETION_TOOL_NAME,
  MAX_KIRO_INJECTED_INSTRUCTION_CHARS,
  type KiroCompletionMode,
} from "./kiro-constants";

/** Serialization headroom for the one adapter-owned completion-validation replay. */
export const KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES = 64 * 1024;

/** True only when no later user/tool-result work follows the delivered final answer. */
export function hasTrailingDeliveredFinalAnswer(
  messages: readonly OcxMessage[],
  parsed?: OcxParsedRequest,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") return false;
    const assistant = message as OcxAssistantMessage;
    if ((assistant.content ?? []).some(part => part.type === "toolCall")) return false;
    const hasText = (assistant.content ?? []).some(part => part.type === "text" && part.text.trim());
    if (!hasText) continue;
    return assistant.phase === "final_answer"
      || (parsed !== undefined && hasRecordedTrailingDeliveredFinalAnswer(parsed, messages));
  }
  return false;
}

/** Decide whether Kiro must use the private terminal completion channel for this turn. */
export function resolveKiroCompletionMode(
  parsed: OcxParsedRequest,
  ordinaryToolCount: number,
  forcedCompletionMode?: KiroCompletionMode,
): KiroCompletionMode {
  if (forcedCompletionMode) return forcedCompletionMode;
  if (ordinaryToolCount === 0) return "disabled";
  return hasTrailingDeliveredFinalAnswer(parsed.context.messages, parsed) ? "disabled" : "required";
}

export function boundedKiroInjectedInstruction(text: string, used: { value: number }): string | undefined {
  const remaining = MAX_KIRO_INJECTED_INSTRUCTION_CHARS - used.value;
  if (remaining <= 0 || !text) return undefined;
  let result = text.length <= remaining ? text : text.slice(0, remaining);
  // Never end the slice on a lone high surrogate: encoding it substitutes U+FFFD.
  if (result.length > 0) {
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  }
  used.value += result.length;
  return result.length > 0 ? result : undefined;
}

/** Test-only stable facade for the injected-instruction bound. */
export function boundedInjectedInstructionForTests(
  text: string,
  used: { value: number },
): string | undefined {
  return boundedKiroInjectedInstruction(text, used);
}

/** Provider-private terminal tool. It is policy, not an ordinary work-tool codec detail. */
export function kiroCompletionTool(): Record<string, unknown> {
  return {
    toolSpecification: {
      name: KIRO_COMPLETION_TOOL_NAME,
      description: "Terminal completion channel, not an ordinary work tool. When the task is fully complete and no more work or tool calls are needed, you must call this tool exactly once instead of providing the final answer as ordinary assistant text. Call it the same way when you cannot continue until the user supplies a decision, information, or a clarification that only they can give: the question itself is the answer. Put the complete user-facing final answer in `answer`. The call is complete when issued: it ends the turn, returns no tool result, and no text or tool call may follow it.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "The complete final answer to show the user, or the blocking question you need the user to answer before you can continue.",
            },
          },
          required: ["answer"],
        },
      },
    },
  };
}

/**
 * Prepare the canonical history used by the single bounded completion-validation attempt.
 * This contains no native Kiro/AWS fields and deliberately preserves visible assistant progress.
 */
export function prepareKiroCompletionRetry(
  requestSnapshot: OcxParsedRequest,
  returnedConversationId: string | undefined,
  assistantText: string,
): OcxParsedRequest {
  const retryParsed = structuredClone(requestSnapshot);
  retryParsed._providerContinuation = {
    ...(retryParsed._providerContinuation ?? {}),
    ...(returnedConversationId ? { kiro: { conversationId: returnedConversationId } } : {}),
  };
  // Reasoning is not replayable on the Kiro wire. Only visible text earns a replay turn.
  if (assistantText.trim()) {
    retryParsed.context.messages.push({
      role: "assistant",
      content: [{ type: "text" as const, text: assistantText }],
      model: retryParsed.modelId,
      timestamp: Date.now(),
    });
  }
  return retryParsed;
}

/** Exact UTF-8 size JSON.stringify() will use for a string, without materializing that copy. */
export function jsonStringSerializedUtf8Bytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
