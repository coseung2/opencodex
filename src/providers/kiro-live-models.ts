/**
 * Live Kiro model discovery through the control plane's `List-Available-Models` operation.
 *
 * The Kiro CLI does not ship a model table either: it calls this endpoint
 * (`KiroControlPlaneBearerClient.ListAvailableModels`, `GET /List-Available-Models`) and reads each
 * entry's `additionalModelRequestFieldsSchema` to learn which native effort field that model takes —
 * `output_config.effort` for the Claude family, `reasoning.effort` for the Sol family. Driving the
 * catalog from the service keeps newer tiers (`claude-opus-5.5`, `gpt-6-astra`, ...) discoverable
 * without editing a static list; that list stays as the failure fallback.
 */
const KIRO_AVAILABLE_MODELS_PATH = "/List-Available-Models";
const KIRO_MODEL_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;
const KIRO_MODEL_DISCOVERY_MAX_MODELS = 500;
const KIRO_MODEL_ID_MAX_LENGTH = 1_024;
const KIRO_EFFORT_PATHS = ["output_config", "reasoning"] as const;
const KIRO_MODEL_ID_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type KiroNativeEffortPath = (typeof KIRO_EFFORT_PATHS)[number];

export interface KiroAvailableModel {
  id: string;
  name?: string;
  /** Native effort field the service publishes for this model, when it publishes one. */
  effortPath?: KiroNativeEffortPath;
  /** Effort values that field accepts, when the schema enumerates them. */
  effortLevels?: string[];
}

export type KiroAvailableModelsResult =
  | { ok: true; models: KiroAvailableModel[] }
  | {
      ok: false;
      error: "auth" | "http" | "transport" | "timeout" | "invalid" | "empty";
      detail?: string;
    };

export interface KiroAvailableModelsOptions {
  accessToken: string;
  region: string;
  profileArn?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** `GET https://q.<region>.amazonaws.com/List-Available-Models`, matching the CLI's request. */
export function kiroAvailableModelsUrl(region: string, profileArn?: string): string {
  const url = new URL(`https://q.${region}.amazonaws.com${KIRO_AVAILABLE_MODELS_PATH}`);
  url.searchParams.set("origin", "KIRO_CLI");
  if (profileArn) url.searchParams.set("profileArn", profileArn);
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 64 || KIRO_MODEL_ID_CONTROL_CHARS.test(trimmed)) continue;
    values.push(trimmed);
  }
  return values.length > 0 ? values : undefined;
}

/** Effort values from a JSON-schema node: `enum`, or `oneOf`/`anyOf` string consts. */
function schemaEnumValues(node: unknown): string[] | undefined {
  const record = asRecord(node);
  if (!record) return undefined;
  const direct = stringValues(record.enum);
  if (direct) return direct;
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = record[key];
    if (!Array.isArray(branches)) continue;
    const consts: unknown[] = [];
    for (const branch of branches) consts.push(asRecord(branch)?.const);
    const values = stringValues(consts);
    if (values) return values;
  }
  return undefined;
}

/**
 * Read the native effort contract the service publishes for one model:
 * `properties.<output_config|reasoning>.properties.effort`.
 */
export function kiroNativeEffortFromSchema(
  schema: unknown,
): Pick<KiroAvailableModel, "effortPath" | "effortLevels"> {
  const properties = asRecord(asRecord(schema)?.properties);
  if (!properties) return {};
  for (const path of KIRO_EFFORT_PATHS) {
    const effort = asRecord(asRecord(asRecord(properties[path])?.properties)?.effort);
    if (!effort) continue;
    const levels = schemaEnumValues(effort);
    return { effortPath: path, ...(levels ? { effortLevels: levels } : {}) };
  }
  return {};
}

/** Parse a `ListAvailableModelsResponse`. Unusable rows are skipped, never fatal. */
export function parseKiroAvailableModels(value: unknown): KiroAvailableModel[] {
  const rows = asRecord(value)?.models;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const models: KiroAvailableModel[] = [];
  for (const raw of rows) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const rawId = entry.modelId;
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (
      !id
      || id !== rawId
      || id.length > KIRO_MODEL_ID_MAX_LENGTH
      || KIRO_MODEL_ID_CONTROL_CHARS.test(id)
      || seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    const rawName = entry.modelName;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : undefined;
    models.push({
      id,
      ...(name ? { name } : {}),
      ...kiroNativeEffortFromSchema(entry.additionalModelRequestFieldsSchema),
    });
    if (models.length >= KIRO_MODEL_DISCOVERY_MAX_MODELS) break;
  }
  return models;
}

export async function fetchKiroAvailableModels(
  opts: KiroAvailableModelsOptions,
): Promise<KiroAvailableModelsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(kiroAvailableModelsUrl(opts.region, opts.profileArn), {
      headers: { Accept: "application/json", Authorization: `Bearer ${opts.accessToken}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "transport",
      detail: error instanceof Error ? error.message : undefined,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "auth", detail: `HTTP ${response.status}` };
  }
  if (!response.ok) return { ok: false, error: "http", detail: `HTTP ${response.status}` };
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > KIRO_MODEL_DISCOVERY_MAX_BYTES) {
    return { ok: false, error: "invalid", detail: "response exceeds 4 MiB" };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: "transport", detail: "response body read failed" };
  }
  if (text.length > KIRO_MODEL_DISCOVERY_MAX_BYTES) {
    return { ok: false, error: "invalid", detail: "response exceeds 4 MiB" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid", detail: "invalid JSON" };
  }
  const models = parseKiroAvailableModels(value);
  if (models.length === 0) return { ok: false, error: "empty" };
  return { ok: true, models };
}
