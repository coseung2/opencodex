/**
 * Wire-level keepalive for every Responses SSE producer.
 *
 * SSE comments are invisible to Codex's eventsource parser, so they do not reset its
 * idle timer. This shared frame is deliberately a standard Responses event. Provider
 * adapters remain responsible for their own event semantics; this only keeps the
 * client-facing stream alive while an adapter or sidecar is still working.
 */
export function responsesProgressFrame(
  sequenceNumber: number,
  responseId = "",
  model = "",
): Uint8Array {
  const response = {
    id: responseId,
    object: "response",
    status: "in_progress",
    model,
    output: [],
    usage: null,
  };
  const payload = {
    type: "response.in_progress",
    sequence_number: sequenceNumber,
    response,
  };
  return new TextEncoder().encode(`event: response.in_progress\ndata: ${JSON.stringify(payload)}\n\n`);
}
