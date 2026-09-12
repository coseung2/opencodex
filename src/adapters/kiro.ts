import {
  releaseTranslatedEvent,
  retainTranslatedEvent,
  type TranslatorBudget,
} from "../lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import type { AdapterFetchContext, AdapterRequest } from "./base";
import {
  hasTrailingDeliveredFinalAnswer,
  jsonStringSerializedUtf8Bytes,
  KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES,
  prepareKiroCompletionRetry,
} from "./kiro-continuity";
import {
  kiroUpstreamContextWindow,
  parseKiroStream,
} from "./kiro-codec";
import type { KiroCompletionMode } from "./kiro-constants";
import { safeKiroHttpErrorMessage } from "./kiro-errors";
import {
  buildKiroNativeRequest,
  fetchKiroNativeResponse,
  noteKiroNativeTransientThrottle,
} from "./kiro-transport";

export {
  boundedInjectedInstructionForTests,
  hasTrailingDeliveredFinalAnswer,
} from "./kiro-continuity";
export {
  buildKiroPayload,
  isRetryableKiroStreamCatchError,
  kiroReasoningMode,
  parseKiroStream,
} from "./kiro-codec";

/**
 * Stable ProviderAdapter facade for Kiro.
 *
 * Policy lives in kiro-continuity, wire translation in kiro-codec, and native
 * CodeWhisperer auth/headers/fetch in kiro-transport. Keep this file limited to
 * per-request orchestration between those boundaries.
 */
export function createKiroAdapter(provider: OcxProviderConfig): ProviderAdapter {
  let inputTokens = 0;
  let contextInputEstimate = 0;
  let modelId: string | undefined;
  let contextWindow: number | undefined;
  let toolNameMap: Map<string, string> | undefined;
  let conversationId: string | undefined;
  let completionMode: KiroCompletionMode = "disabled";
  let requestSnapshot: OcxParsedRequest | undefined;
  let firstRequestBodyBytes = 0;
  let requestAbortSignal: AbortSignal | undefined;

  const build = (parsed: OcxParsedRequest, forcedCompletionMode?: KiroCompletionMode) =>
    buildKiroNativeRequest(provider, parsed, forcedCompletionMode);

  const fallbackFactory = async (
    returnedConversationId: string | undefined,
    assistantText: string,
    _sawReasoning: boolean,
    budget: TranslatorBudget,
  ) => {
    if (!requestSnapshot) throw new Error("Kiro completion retry lost its request state");
    if (requestAbortSignal?.aborted) {
      throw requestAbortSignal.reason instanceof Error
        ? requestAbortSignal.reason
        : new DOMException("Kiro request was cancelled", "AbortError");
    }

    const retryParsed = prepareKiroCompletionRetry(requestSnapshot, returnedConversationId, assistantText);
    const retryBodyUpperBound = firstRequestBodyBytes
      + jsonStringSerializedUtf8Bytes(assistantText)
      + KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES;
    const retryBodyReservation = budget.reserveTransient(retryBodyUpperBound, { kind: "request_copies" });
    let retryBodyBytes = 0;
    let retryBodyRetained = false;
    let requestBodyReleased = false;
    const releaseRequestBody = () => {
      if (requestBodyReleased) return;
      requestBodyReleased = true;
      if (retryBodyRetained) budget.releaseRetained(retryBodyBytes, { kind: "request_copies" });
      else retryBodyReservation.release();
    };

    try {
      const retry = await build(retryParsed, "text_fallback");
      retryBodyBytes = Buffer.byteLength(retry.request.body);
      if (retryBodyBytes > retryBodyUpperBound) {
        throw new Error("Kiro retry serialization exceeded its pre-admitted upper bound");
      }
      retryBodyReservation.commitRetained();
      retryBodyRetained = true;
      budget.releaseRetained(retryBodyUpperBound - retryBodyBytes, { kind: "request_copies" });
      const response = await fetchKiroNativeResponse(retry.request, {
        abortSignal: requestAbortSignal,
        returnRawErrors: true,
        stream: true,
      });
      return {
        response,
        inputTokens: retry.inputTokens,
        contextInputEstimate: retry.contextInputEstimate,
        nameMap: retry.nameMap,
        conversationId: retry.conversationId,
        releaseRequestBody,
      };
    } catch (error) {
      releaseRequestBody();
      throw error;
    }
  };

  return {
    name: "kiro",

    localTerminal(parsed: OcxParsedRequest) {
      return hasTrailingDeliveredFinalAnswer(parsed.context.messages, parsed)
        ? { reason: "kiro_final_answer_already_delivered" }
        : undefined;
    },

    async buildRequest(parsed: OcxParsedRequest, incoming) {
      const built = await build(parsed);
      modelId = parsed.modelId;
      contextWindow = kiroUpstreamContextWindow(parsed.modelId);
      inputTokens = built.inputTokens;
      contextInputEstimate = built.contextInputEstimate;
      toolNameMap = built.nameMap;
      conversationId = built.conversationId;
      completionMode = built.completionMode;
      requestSnapshot = structuredClone(parsed);
      firstRequestBodyBytes = Buffer.byteLength(built.request.body);
      requestAbortSignal = incoming?.abortSignal;
      return built.request;
    },

    parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      return parseKiroStream(
        response,
        budget,
        modelId,
        inputTokens,
        contextWindow,
        toolNameMap,
        conversationId,
        completionMode,
        completionMode === "required" ? fallbackFactory : undefined,
        contextInputEstimate,
        noteKiroNativeTransientThrottle,
      );
    },

    fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      if (ctx?.abortSignal) requestAbortSignal = ctx.abortSignal;
      return fetchKiroNativeResponse(request, ctx);
    },

    formatErrorBody(status: number, headers: Headers, payloadText: string): string {
      return safeKiroHttpErrorMessage(status, headers, payloadText);
    },

    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      const events: AdapterEvent[] = [];
      try {
        for await (const event of parseKiroStream(
          response,
          budget,
          modelId,
          inputTokens,
          contextWindow,
          toolNameMap,
          conversationId,
          completionMode,
          completionMode === "required" ? fallbackFactory : undefined,
          contextInputEstimate,
          noteKiroNativeTransientThrottle,
        )) {
          retainTranslatedEvent(event, budget, events.at(-1));
          events.push(event);
        }
        return events;
      } catch (error) {
        for (const event of events) releaseTranslatedEvent(event, budget);
        throw error;
      }
    },
  };
}
