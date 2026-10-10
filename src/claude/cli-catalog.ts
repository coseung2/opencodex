import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { pickerEffortTemplate } from "./picker-effort";

export interface ClaudeCliCatalogModel { id: string; name: string; contextWindow?: number; effortLevels?: readonly string[] }
export const CLI_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function claudeCliCatalogKind(method: string, path: string): "selector" | "bootstrap" | null {
  if (method !== "GET") return null;
  if (/^\/api\/(?:organizations\/[^/]+\/)?model_selector\/cc\/?$/.test(path)) return "selector";
  return /^\/api\/claude_cli\/bootstrap\/?$/.test(path) ? "bootstrap" : null;
}
export function claudeCliCatalogEligible(request: Request): boolean {
  const ua = request.headers.get("user-agent") ?? "";
  return /^claude-code\/[^\s]+$/.test(ua)
    || /^claude-cli\/[^\s()]+ \(external, (?:cli|terminal|sdk-cli)(?:, [^,()]+)*\)$/.test(ua);
}

/** Unknown/error catalogs remain untouched. Only the local CLI surface is rewritten. */
export function rewriteClaudeCliCatalog(bytes: Buffer, encoding: string | null, kind: "selector" | "bootstrap", models: readonly ClaudeCliCatalogModel[]): Buffer | null {
  if (!models.length || models.length > 2000 || bytes.length > CLI_CATALOG_MAX_BYTES) return null;
  try {
    const cap = { maxOutputLength: CLI_CATALOG_MAX_BYTES };
    const wire = encoding?.trim().toLowerCase() || "identity";
    const decoded = wire === "identity" ? bytes : wire === "gzip" ? gunzipSync(bytes, cap)
      : wire === "deflate" ? inflateSync(bytes, cap) : wire === "br" ? brotliDecompressSync(bytes, cap) : null;
    if (!decoded || decoded.length > CLI_CATALOG_MAX_BYTES) return null;
    const body: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(decoded));
    if (!record(body)) return null;
    let added = 0;
    let plannedBytes = decoded.length;
    const admit = (row: Record<string, unknown>) => {
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      plannedBytes += bytes;
      if (bytes > 64 * 1024 || plannedBytes > CLI_CATALOG_MAX_BYTES) throw new RangeError("catalog expansion limit");
    };
    const rows = models.filter(model => typeof model.id === "string" && model.id.length <= 512 && /claude|anthropic/i.test(model.id)
      && typeof model.name === "string" && model.name.length <= 160);
    if (kind === "bootstrap") {
      if (body.additional_model_options != null && !Array.isArray(body.additional_model_options)) return null;
      const options = (body.additional_model_options ?? []) as unknown[];
      const seen = new Set(options.flatMap(option => record(option) ? [option.model] : []));
      for (const model of rows) {
        if (seen.has(model.id)) continue;
        const row = { model: model.id, name: model.name, description: "Routed by OpenCodex" };
        admit(row); options.push(row);
        seen.add(model.id); added++;
      }
      body.additional_model_options = options;
    } else {
      if (!Array.isArray(body.model_selector_config)) return null;
      for (const surface of body.model_selector_config) {
        if (!record(surface) || surface.id !== "cc" || !Array.isArray(surface.models)) continue;
        const seen = new Set(surface.models.flatMap(row => record(row) ? [row.id] : []));
        for (const model of rows) {
          if (seen.has(model.id)) continue;
          const template = pickerEffortTemplate(surface.models, model.effortLevels);
          if (!template) continue;
          const copy = { ...template };
          for (const key of Object.keys(copy)) {
            if (/version/i.test(key) || ["disabled", "disabled_reason", "badge", "tooltip", "notice", "selection_notice", "fast_mode", "context_window"].includes(key)) delete copy[key];
          }
          copy.id = model.id; copy.name = model.name; copy.section = "main"; copy.description = "Routed by OpenCodex";
          if (model.contextWindow !== undefined) copy.context_window = model.contextWindow;
          for (const key of ["effort_levels", "supported_effort_levels"]) {
            if (!Object.hasOwn(copy, key)) continue;
            if (!Array.isArray(copy[key]) || !copy[key].every(value => typeof value === "string")) return null;
            copy[key] = copy[key].filter(level => model.effortLevels?.includes(level as string));
          }
          if (Object.hasOwn(copy, "thinking")) {
            if (!record(copy.thinking) || !Array.isArray(copy.thinking.effort_options)
              || !copy.thinking.effort_options.every(option => record(option) && typeof option.id === "string")) return null;
            const options = copy.thinking.effort_options.filter(option => model.effortLevels?.includes(option.id as string));
            if (!options.length) delete copy.thinking;
            else copy.thinking = { ...copy.thinking, effort_options: options };
          }
          admit(copy); surface.models.push(copy); seen.add(model.id); added++;
        }
      }
    }
    if (!added) return null;
    const output = Buffer.from(JSON.stringify(body));
    return output.length <= CLI_CATALOG_MAX_BYTES ? output : null;
  } catch { return null; }
}
