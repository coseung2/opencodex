// Narrow Code bootstrap rewrite adapted from MIT upstream d17a9f2239031df31d978f1419f326142c00d88b.
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { PICKER_MAX_OUTPUT_BYTES, PickerRewriteBudget, pickerRowBytes } from "./picker-budget";
import { pickerEffortTemplate } from "../picker-effort";
export interface PickerModelEntry { id: string; name: string; contextWindow?: number; effortLevels?: readonly string[] }
export const BOOTSTRAP_MAX_ENCODED_BYTES = 4 * 1024 * 1024;
export const BOOTSTRAP_MAX_DECODED_BYTES = PICKER_MAX_OUTPUT_BYTES;
export const PICKER_SURFACE_IDS = ["ccd", "code"] as const;
export type PickerInjectionOutcome = { kind: "rewritten"; added: number } | { kind: "unchanged"; reason: string };
export function isPickerBootstrapRequest(method: string, pathname: string): boolean {
  return method === "GET" && /^\/(?:edge-api|api)\/bootstrap(?:\/[A-Za-z0-9-]+\/app_start)?\/?$/.test(pathname);
}
export function narrowBootstrapAcceptEncoding(): string { return "gzip, deflate, br"; }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const stripped = new Set(["disabled", "disabled_reason", "badge", "tooltip", "description", "fast_mode", "id", "name", "section", "context_window"]);
/** Plan every surface before mutating any of them; unknown catalogs are never guessed. */
export function injectPickerModels(bootstrap: unknown, models: readonly PickerModelEntry[], explain?: (outcome: PickerInjectionOutcome) => void): number {
  const unchanged = (reason: string) => { explain?.({ kind: "unchanged", reason }); return 0; };
  if (!record(bootstrap) || !Array.isArray(bootstrap.model_selector_config)) return unchanged("unknown_shape");
  const targets = bootstrap.model_selector_config.filter((s): s is Record<string, unknown> => record(s) && (s.id === "ccd" || s.id === "code"));
  if (!targets.length) return unchanged("no_code_surface");
  try {
    const budget = new PickerRewriteBudget(bootstrap);
    if (models.length > 4096) return unchanged("rewrite_limit");
    const plans: { entries: unknown[]; additions: Record<string, unknown>[] }[] = [];
    for (const surface of targets) {
      if (!Array.isArray(surface.models)) return unchanged("unknown_shape");
      const template = pickerEffortTemplate(surface.models);
      if (!template) return unchanged("no_template");
      const retained = Object.fromEntries(Object.entries(template).filter(([key]) => !stripped.has(key) && !/version/i.test(key)));
      pickerRowBytes(retained);
      const existing = new Set(surface.models.map(r => record(r) ? r.id : undefined));
      const additions: Record<string, unknown>[] = [];
      for (const model of models) {
        if (!model.id || !model.name || typeof model.id !== "string" || typeof model.name !== "string"
          || (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0))) return unchanged("invalid_model");
        if (existing.has(model.id)) continue;
        const effortTemplate = pickerEffortTemplate(surface.models, model.effortLevels);
        const row: Record<string, unknown> = { ...retained, id: model.id, name: model.name, section: "main" };
        for (const key of ["thinking", "effort_levels", "supported_effort_levels"]) {
          delete row[key];
          if (effortTemplate && Object.hasOwn(effortTemplate, key)) row[key] = effortTemplate[key];
        }
        if (model.contextWindow !== undefined) row.context_window = model.contextWindow;
        // Do not advertise effort controls beyond the native template's supported vocabulary.
        for (const key of ["effort_levels", "supported_effort_levels"]) {
          if (Object.hasOwn(row, key)) {
            if (!Array.isArray(row[key]) || !(row[key] as unknown[]).every(v => typeof v === "string")) return unchanged("unknown_effort_shape");
            row[key] = (row[key] as string[]).filter(level => model.effortLevels?.includes(level));
          }
        }
        if (Object.hasOwn(row, "thinking")) {
          if (!record(row.thinking) || !Array.isArray(row.thinking.effort_options)
            || !row.thinking.effort_options.every(option => record(option) && typeof option.id === "string")) return unchanged("unknown_effort_shape");
          const options = row.thinking.effort_options.filter(option => model.effortLevels?.includes(option.id as string));
          if (options.length === 0) delete row.thinking;
          else {
            const preferred = options.find(option => option.id === "high") ?? options[0]!;
            row.thinking = { ...row.thinking, effort_options: options.map(option => {
              const { recommended: _recommended, ...retainedOption } = option;
              return option === preferred ? { ...retainedOption, recommended: true } : retainedOption;
            }) };
          }
        }
        budget.reserveRow(row); additions.push(structuredClone(row)); existing.add(model.id);
      }
      plans.push({ entries: surface.models, additions });
    }
    const added = plans.reduce((n, p) => n + p.additions.length, 0);
    if (!added) return unchanged(models.length ? "all_present" : "no_routes");
    for (const plan of plans) plan.entries.push(...plan.additions);
    explain?.({ kind: "rewritten", added }); return added;
  } catch { return unchanged("rewrite_limit"); }
}
export function rewriteBootstrapBody(encoded: Buffer, contentEncoding: string | undefined, models: readonly PickerModelEntry[], explain?: (outcome: PickerInjectionOutcome) => void): Buffer | null {
  const unchanged = (reason: string): null => { explain?.({ kind: "unchanged", reason }); return null; };
  if (encoded.length > BOOTSTRAP_MAX_ENCODED_BYTES) return unchanged("encoded_cap");
  try {
    let decoded: Buffer;
    switch (contentEncoding?.trim().toLowerCase() || "identity") {
      case "identity": decoded = encoded; break;
      case "gzip": case "x-gzip": decoded = gunzipSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "deflate": decoded = inflateSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      case "br": decoded = brotliDecompressSync(encoded, { maxOutputLength: BOOTSTRAP_MAX_DECODED_BYTES }); break;
      default: return unchanged("unsupported_encoding");
    }
    if (decoded.length > BOOTSTRAP_MAX_DECODED_BYTES) return unchanged("decoded_cap");
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    // Only report success once serialization and final size validation also pass.
    let outcome: PickerInjectionOutcome | undefined;
    if (!injectPickerModels(parsed, models, value => { outcome = value; })) { if (outcome) explain?.(outcome); return null; }
    const output = Buffer.from(JSON.stringify(parsed));
    if (output.length > BOOTSTRAP_MAX_DECODED_BYTES) return unchanged("rewrite_limit");
    if (outcome) explain?.(outcome); return output;
  } catch { return unchanged("decode_or_parse_failed"); }
}
export function rewrittenHeaders(raw: readonly string[], bodyLength: number): string[] {
  const removed = new Set(["content-encoding", "content-length", "etag", "digest", "content-md5", "transfer-encoding"]);
  const result: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (!removed.has(raw[i]!.toLowerCase())) result.push(raw[i]!, raw[i + 1]!);
  return [...result, "Content-Length", String(bodyLength)];
}
