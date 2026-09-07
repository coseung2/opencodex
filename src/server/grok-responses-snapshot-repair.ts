import type { TranslatorBudget } from "../lib/translator-budget";
import { MAX_COMPLETED_OUTPUT_ITEMS, MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES } from "./relay";
import type { SsePayloadRewrite } from "./sse-payload-rewrite";

interface OpenItemIdentity {
  type: string;
  id?: string;
  sourceBytes: number;
}

interface CompletedItem {
  item: Record<string, unknown>;
  sourceBytes: number;
  visibleToGrok: boolean;
}

const SUPPORTED_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "web_search_call",
  "code_interpreter_call",
  "mcp_call",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validOptionalId(item: Record<string, unknown>): boolean {
  return !("id" in item) || (typeof item.id === "string" && item.id.trim().length > 0);
}

function completedStatusWhenPresent(item: Record<string, unknown>): boolean {
  return !("status" in item) || item.status === "completed";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function backfillOutputTextPart(part: unknown): unknown {
  if (!isPlainObject(part) || part.type !== "output_text" || Array.isArray(part.annotations)) return part;
  return { ...part, annotations: [] };
}

function backfillMessageItem(item: unknown): unknown {
  if (!isPlainObject(item) || item.type !== "message" || !Array.isArray(item.content)) return item;
  let changed = false;
  const content = item.content.map(part => {
    const next = backfillOutputTextPart(part);
    changed ||= next !== part;
    return next;
  });
  return changed ? { ...item, content } : item;
}

function backfillGrokRequiredFields(payload: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  if (isPlainObject(payload.item)) {
    const item = backfillMessageItem(payload.item);
    if (item !== payload.item) { next.item = item; changed = true; }
  }
  if (isPlainObject(payload.part)) {
    const part = backfillOutputTextPart(payload.part);
    if (part !== payload.part) { next.part = part; changed = true; }
  }
  if (isPlainObject(payload.response) && Array.isArray(payload.response.output)) {
    let outputChanged = false;
    const output = payload.response.output.map(item => {
      const repaired = backfillMessageItem(item);
      outputChanged ||= repaired !== item;
      return repaired;
    });
    if (outputChanged) {
      next.response = { ...payload.response, output };
      changed = true;
    }
  }
  return changed ? next : payload;
}

function validOutputMessagePart(part: unknown): boolean {
  if (!isPlainObject(part)) return false;
  if (part.type === "output_text") {
    return typeof part.text === "string"
      && (!("annotations" in part) || Array.isArray(part.annotations))
      && (!("logprobs" in part) || part.logprobs === null || Array.isArray(part.logprobs));
  }
  return part.type === "refusal" && typeof part.refusal === "string";
}

function validReasoningPart(part: unknown, type: "summary_text" | "reasoning_text"): boolean {
  return isPlainObject(part) && part.type === type && typeof part.text === "string";
}

function validWebSearchAction(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.type === "search") {
    return typeof value.query === "string"
      && (!("sources" in value) || value.sources === null || (Array.isArray(value.sources)
        && value.sources.every(source => isPlainObject(source)
          && typeof source.type === "string" && typeof source.url === "string")));
  }
  if (value.type === "open_page") return !("url" in value) || nullableString(value.url);
  if (value.type === "find" || value.type === "find_in_page") {
    return typeof value.url === "string" && typeof value.pattern === "string";
  }
  return false;
}

function validCodeInterpreterOutput(value: unknown): boolean {
  return isPlainObject(value)
    && ((value.type === "logs" && typeof value.logs === "string")
      || (value.type === "image" && typeof value.url === "string"));
}

/**
 * Accept only semantic-complete items from a real output_item.done. Missing optional ids/status
 * are tolerated, but content is never invented to justify a sparse terminal reconstruction.
 */
function trustedCompletedItem(item: Record<string, unknown>): { visibleToGrok: boolean } | null {
  if (!validOptionalId(item) || !completedStatusWhenPresent(item)) return null;

  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) return null;
    if (!item.content.every(validOutputMessagePart)) return null;
    if ("phase" in item && item.phase !== "commentary" && item.phase !== "final_answer") return null;
    return {
      visibleToGrok: item.content.some(part => isPlainObject(part)
        && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0),
    };
  }

  if (item.type === "reasoning") {
    if (!Array.isArray(item.summary) || !item.summary.every(part => validReasoningPart(part, "summary_text"))) return null;
    if ("content" in item && item.content !== null
      && (!Array.isArray(item.content) || !item.content.every(part => validReasoningPart(part, "reasoning_text")))) return null;
    if ("encrypted_content" in item && !nullableString(item.encrypted_content)) return null;
    return { visibleToGrok: false };
  }

  if (item.type === "function_call") {
    if (typeof item.call_id !== "string" || item.call_id.trim().length === 0
      || typeof item.name !== "string" || item.name.trim().length === 0
      || typeof item.arguments !== "string") return null;
    return { visibleToGrok: true };
  }

  if (item.type === "custom_tool_call") {
    if (typeof item.call_id !== "string" || item.call_id.trim().length === 0
      || typeof item.name !== "string" || item.name.trim().length === 0
      || typeof item.input !== "string") return null;
    return { visibleToGrok: false };
  }

  if (item.type === "web_search_call") {
    if (item.status !== "completed" || !validWebSearchAction(item.action)) return null;
    return { visibleToGrok: false };
  }

  if (item.type === "code_interpreter_call") {
    if (item.status !== "completed"
      || typeof item.container_id !== "string" || item.container_id.trim().length === 0
      || ("code" in item && !nullableString(item.code))
      || ("outputs" in item && item.outputs !== null
        && (!Array.isArray(item.outputs) || !item.outputs.every(validCodeInterpreterOutput)))) return null;
    return { visibleToGrok: false };
  }

  if (item.type === "mcp_call") {
    if (typeof item.arguments !== "string"
      || typeof item.name !== "string" || item.name.trim().length === 0
      || typeof item.server_label !== "string" || item.server_label.trim().length === 0
      || ("approval_request_id" in item && !nullableString(item.approval_request_id))
      || ("error" in item && !nullableString(item.error))
      || ("output" in item && !nullableString(item.output))) return null;
    return { visibleToGrok: false };
  }

  return null;
}

function plausibleOpenItem(item: Record<string, unknown>): Omit<OpenItemIdentity, "sourceBytes"> | null {
  const type = typeof item.type === "string" ? item.type : "";
  if (!SUPPORTED_ITEM_TYPES.has(type) || !validOptionalId(item)) return null;
  if ("status" in item && item.status !== "in_progress") return null;
  if (type === "message") {
    if ("role" in item && item.role !== "assistant") return null;
    if ("content" in item && !Array.isArray(item.content)) return null;
  }
  return { type, ...(typeof item.id === "string" ? { id: item.id } : {}) };
}

/**
 * Grok Build shows streaming deltas live but persists the final assistant turn from
 * response.completed.response.output. Some native Responses streams leave that terminal array
 * absent/empty while carrying complete items in output_item.done. Reconstruct only the sparse
 * terminal case from unique, contiguous, bounded, validated done events; every ambiguity fails
 * closed and leaves the provider payload byte-equivalent.
 */
export function createGrokResponsesSparseTerminalPayloadRewrite(
  budget?: TranslatorBudget,
): SsePayloadRewrite {
  const openItems = new Map<number, OpenItemIdentity>();
  const completedItems = new Map<number, CompletedItem>();
  let aggregateCompletedBytes = 0;
  let aggregateOpenBytes = 0;
  let tainted = false;
  let hasVisibleOutput = false;

  const clearRetained = (): void => {
    const retained = aggregateCompletedBytes + aggregateOpenBytes;
    if (retained > 0) budget?.releaseRetained(retained, { kind: "retained_collectors" });
    openItems.clear();
    completedItems.clear();
    aggregateCompletedBytes = 0;
    aggregateOpenBytes = 0;
    hasVisibleOutput = false;
  };
  const reset = (): void => {
    clearRetained();
    tainted = false;
  };
  const taint = (): void => {
    clearRetained();
    tainted = true;
  };

  const closeOpen = (index: number): void => {
    const open = openItems.get(index);
    if (!open) return;
    openItems.delete(index);
    aggregateOpenBytes -= open.sourceBytes;
    budget?.releaseRetained(open.sourceBytes, { kind: "retained_collectors" });
  };

  const rewrite = ((payload: string): string => {
    if (payload === "[DONE]") {
      reset();
      return payload;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(payload); }
    catch { taint(); return payload; }
    if (!isPlainObject(decoded) || typeof decoded.type !== "string") {
      taint();
      return payload;
    }
    const parsed = backfillGrokRequiredFields(decoded);
    const basePayload = parsed === decoded ? payload : JSON.stringify(parsed);

    const outputIndex = Number.isInteger(parsed.output_index) && (parsed.output_index as number) >= 0
      ? parsed.output_index as number
      : undefined;

    if (parsed.type === "response.output_item.added") {
      const open = isPlainObject(parsed.item) ? plausibleOpenItem(parsed.item) : null;
      if (outputIndex === undefined || !open || openItems.has(outputIndex) || completedItems.has(outputIndex)
        || openItems.size >= MAX_COMPLETED_OUTPUT_ITEMS) {
        taint();
      } else if (!tainted) {
        const sourceBytes = Buffer.byteLength(JSON.stringify(open), "utf8");
        if (sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES
          || aggregateOpenBytes + sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
          taint();
        } else {
          budget?.chargeRetained(sourceBytes, { kind: "retained_collectors" });
          openItems.set(outputIndex, { ...open, sourceBytes });
          aggregateOpenBytes += sourceBytes;
        }
      }
      return basePayload;
    }

    if (parsed.type === "response.output_item.done") {
      const item = isPlainObject(parsed.item) ? parsed.item : null;
      const proof = item ? trustedCompletedItem(item) : null;
      if (outputIndex === undefined || !proof || completedItems.has(outputIndex)) {
        taint();
        return basePayload;
      }
      const open = openItems.get(outputIndex);
      const doneId = typeof item!.id === "string" ? item!.id : undefined;
      if (open && (open.type !== item!.type || open.id !== doneId)) {
        taint();
        return basePayload;
      }
      closeOpen(outputIndex);
      if (!tainted) {
        const sourceBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
        if (sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES
          || completedItems.size >= MAX_COMPLETED_OUTPUT_ITEMS
          || aggregateCompletedBytes + sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
          taint();
        } else {
          budget?.chargeRetained(sourceBytes, { kind: "retained_collectors" });
          completedItems.set(outputIndex, { item: item!, sourceBytes, visibleToGrok: proof.visibleToGrok });
          aggregateCompletedBytes += sourceBytes;
          hasVisibleOutput ||= proof.visibleToGrok;
        }
      }
      return basePayload;
    }

    const terminal = parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete";
    if (!terminal) return basePayload;

    let rewritten = basePayload;
    if (parsed.type === "response.completed" && !tainted && isPlainObject(parsed.response)) {
      const response = parsed.response;
      const output = response.output;
      const statusConsistent = !("status" in response) || response.status === "completed";
      const authoritative = Array.isArray(output) && output.length > 0;
      const sparse = !("output" in response) || (Array.isArray(output) && output.length === 0);
      if (!authoritative && sparse && statusConsistent && completedItems.size > 0
        && openItems.size === 0 && hasVisibleOutput) {
        const ordered = [...completedItems.entries()].sort(([a], [b]) => a - b);
        if (ordered.every(([index], position) => index === position)) {
          rewritten = JSON.stringify({
            ...parsed,
            response: { ...response, output: ordered.map(([, retained]) => retained.item) },
          });
        }
      }
    }
    reset();
    return rewritten;
  }) as SsePayloadRewrite;

  rewrite.dispose = reset;
  return rewrite;
}
