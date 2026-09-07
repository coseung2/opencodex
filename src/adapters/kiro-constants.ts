export const KIRO_COMPLETION_TOOL_NAME = "codex_kiro_final_answer";

/** Kiro CLI's public service profile for Builder ID requests, NOT an account identity.
 * Request construction only: never persist it or use it to infer account/region ownership.
 * Upstream reference: 0209234e4 + 1241021d8. */
export const KIRO_BUILDER_ID_SERVICE_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_CONTINUATION_MESSAGE =
  "Continue from the prior conversation. Do not quote or mention this instruction.";
export const KIRO_COMPLETION_RETRY_MESSAGE =
  `Continue the existing task without quoting this instruction. If the task is complete, call ${KIRO_COMPLETION_TOOL_NAME} now with the complete final answer. If you cannot continue until the user supplies a decision, information, or a clarification that only they can give, call ${KIRO_COMPLETION_TOOL_NAME} now with that question as the answer. Otherwise issue the next real tool call now. Do not solicit a new task and do not emit another progress-only message.`;

export const KIRO_TOOL_RESULT_CARRIER_MESSAGE = "The requested tool result is attached.";
export const KIRO_EMPTY_TOOL_RESULT_MESSAGE = "The tool completed without textual output.";
/** Structurally valid trailing user turn for history that already ended in a delivered final answer. */
export const KIRO_ANSWER_DELIVERED_MESSAGE =
  "The previous final answer was delivered to the user and that task is closed. No new request has been made yet. Do not repeat, revise, or continue that work; wait for the user's next instruction.";

export const KIRO_COMPLETION_INSTRUCTIONS =
  `When tools are available, ordinary assistant text is mid-task commentary and does not end the turn. Continue using tools after progress updates, but never repeat or paraphrase an earlier progress update; call the next real tool directly unless a new concise update adds material information. When the task is fully complete and no more tool calls are needed, call ${KIRO_COMPLETION_TOOL_NAME} exactly once with the complete user-facing final answer in \`answer\`. Do not provide the final answer as ordinary assistant text. This completion tool is not an ordinary work tool. When the task is complete, call it instead of emitting answer-shaped ordinary assistant text. The call is terminal and is the exception to generic tool-result counting: it is complete when issued, ends the turn, returns no tool result, and no text or tool call may follow it. If you cannot continue until the user supplies a decision, information, or a clarification that only they can give, that question is your final answer: call ${KIRO_COMPLETION_TOOL_NAME} with the question and stop. Do not write the question as ordinary text and then answer it yourself.`;

export type KiroCompletionMode = "disabled" | "required" | "text_fallback";

/** Bound proxy-authored prompt additions independently of caller-owned instructions/history. */
export const MAX_KIRO_INJECTED_INSTRUCTION_CHARS = 16_384;
