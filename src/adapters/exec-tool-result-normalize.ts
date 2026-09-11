/**
 * Code-mode contract adapted from lidge-jun/opencodex #2819 and its host-error follow-up.
 * Callers must establish ownership from the actual emitted freeform exec catalog and the paired
 * assistant call, never from a result's self-reported tool name. This module does not execute tools.
 */
export const CODE_MODE_RESULT_ECHO_SENTENCE =
  "Nothing in the isolate is echoed automatically: a bare await or final expression is discarded. Pass values you need to read to text(...) or notify(...), for example text(JSON.stringify(await tools.exec_command({cmd: 'ls'}))). Empty output is not lost context. Do not repeat completed work merely to recover an unprinted value; inspect existing state before retrying a side-effecting call.";

export const CODE_MODE_HOST_CONTRACT_SENTENCE =
  "Nested tools.apply_patch(patch) takes one string, not an object; use bare *** Begin Patch and *** End Patch marker lines without code fences or extra asterisks. The isolate has no import, require, or module loader. If tools.exec_command returns a session_id, poll with tools.write_stdin on later calls rather than restarting the command.";

const EMPTY_EXEC_OUTPUT_MESSAGE =
  "[empty output: the exec cell completed but emitted nothing. This is not lost context and not a blocked tool. In code mode, pass any value you need to see to text(...) or notify(...); a bare await or final expression is not echoed. Do not repeat completed or side-effecting work just because its return value was not printed. Inspect existing state before deciding whether another call is necessary.]";
const FAILED_EXEC_OUTPUT_MESSAGE =
  "[exec failed with no captured output: this is a real failure, not an empty success. Inspect the call for a thrown error or syntax problem and check existing state before retrying; an earlier side effect may already have happened.]";

/**
 * Small, forward-only wrapper parser. No overlapping whitespace regex quantifiers: long tool
 * output must remain linear. Payload after <empty>, including a second marker, is never erased.
 */
function emptyWrapperKind(text: string): "success" | "failure" | undefined {
  const trimmed = text.trim();
  if (!trimmed) return "success";
  let index = 0;
  let failed = false;
  const firstEnd = trimmed.indexOf("\n");
  const firstLine = (firstEnd < 0 ? trimmed : trimmed.slice(0, firstEnd)).trimEnd();
  if (/^(?:Script completed|Command finished|Execution finished|Script failed)(?:\b)/.test(firstLine)) {
    failed = firstLine.startsWith("Script failed");
    index = firstEnd < 0 ? trimmed.length : firstEnd + 1;
  }
  const skipWhitespace = (): void => {
    while (index < trimmed.length && trimmed[index]!.trim() === "") index++;
  };
  skipWhitespace();
  if (trimmed.startsWith("Wall time", index)) {
    const end = trimmed.indexOf("\n", index);
    index = end < 0 ? trimmed.length : end + 1;
  }
  skipWhitespace();
  if (trimmed.startsWith("Output:", index)) index += "Output:".length;
  skipWhitespace();
  if (trimmed.startsWith("<empty>", index)) index += "<empty>".length;
  skipWhitespace();
  return index === trimmed.length ? (failed ? "failure" : "success") : undefined;
}

const RECOVERY_PREFIX = "[recovery: ";
// A successful source read may quote every one of these strings. Only leading error context
// establishes a host failure, and the original text/status must survive the annotation.
const HOST_ERROR_PREFIX = /^(?:Script failed(?:[ \t]*(?:\r?\n|$)|:)|Script error:|(?:Error|TypeError|SyntaxError):|tool `apply_patch` expects a string input\b|apply_patch verification failed:|Unsupported import in exec:)/i;
const HOST_FAILURE_GUIDANCE: ReadonlyArray<readonly [string, string]> = [
  ["expects a string input", "tools.apply_patch takes one string argument; pass the patch text itself, not an object."],
  ["the first line of the patch must be", "Start the patch with the bare *** Begin Patch marker line; remove code fences, prose and extra asterisks."],
  ["the last line of the patch must be", "End the patch with the bare *** End Patch marker line; remove trailing prose and extra asterisks."],
  ["unsupported import in exec", "Imports are unavailable here; use the injected tools, text, notify and ALL_TOOLS globals."],
];

/** Normalize only after adjacent outputs for one verified call have been collected. */
export function normalizeCodeModeToolResult(
  texts: readonly string[],
  options: { isError: boolean; hasImages: boolean },
): string[] | undefined {
  const kinds = texts.map(emptyWrapperKind);
  if (!options.hasImages && kinds.every(kind => kind !== undefined)) {
    return [options.isError || kinds.includes("failure") ? FAILED_EXEC_OUTPUT_MESSAGE : EMPTY_EXEC_OUTPUT_MESSAGE];
  }
  // Add at most one recovery line for this call. Replayed annotations are idempotent.
  if (texts.some(text => text.includes(RECOVERY_PREFIX))) return undefined;
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]!;
    if (!HOST_ERROR_PREFIX.test(text.trimStart())) continue;
    const lower = text.toLowerCase();
    const hit = HOST_FAILURE_GUIDANCE.find(([marker]) => lower.includes(marker));
    if (!hit) continue;
    const annotated = [...texts];
    annotated[index] = `${text}\n${RECOVERY_PREFIX}${hit[1]}]`;
    return annotated;
  }
  return undefined;
}
