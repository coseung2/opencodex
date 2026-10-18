import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig, OcxClaudeCodeConfig } from "../types";
import { buildClaudeAgentDefs, syncClaudeAgentDefs, type ClaudeAgentBuildOptions } from "./agents-inject";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\s<>\x00-\x1f]/.test(value);
}
function invalid(): never { throw new Error("Invalid VM Notch agent catalog; existing definitions retained."); }

export function buildNotchAgentDefs(input: unknown, configDir: string, onSkipped?: (ids: string[]) => void) {
  if (!record(input) || input.schemaVersion !== 1 || input.source !== "remote") invalid();
  if (!Array.isArray(input.chosen) || input.chosen.length > 5 || !input.chosen.every(identifier)) invalid();
  const chosen = input.chosen as string[];
  if (new Set(chosen).size !== chosen.length || !record(input.injection) || !Array.isArray(input.injection.available)) invalid();
  const entries: NonNullable<ClaudeAgentBuildOptions["resolvedEntries"]> = Object.create(null);
  for (const row of input.injection.available) {
    if (!record(row) || !identifier(row.namespaced) || !identifier(row.model) || !identifier(row.provider)) invalid();
    if (!/^[a-zA-Z0-9_-]+$/.test(row.provider) || entries[row.namespaced]) invalid();
    const native = row.namespaced === row.model;
    if (native && row.provider !== "openai") invalid();
    (entries as Record<string, { provider: string; model: string; native: boolean }>)[row.namespaced] = {
      provider: row.provider, model: row.model, native,
    };
  }
  // The roster follows the VM's subagent list. A pick the injection list omits (it carries
  // only one row per public slug) still resolves from that list's `provider/model` slug.
  const listed = new Set(Array.isArray(input.available) ? input.available.filter(identifier) : []);
  for (const id of chosen) {
    if (entries[id] || !listed.has(id)) continue;
    const slash = id.indexOf("/");
    const provider = id.slice(0, slash);
    if (slash <= 0 || !/^[a-zA-Z0-9_-]+$/.test(provider) || slash === id.length - 1) continue;
    (entries as Record<string, { provider: string; model: string; native: boolean }>)[id] = {
      provider, model: id.slice(slash + 1), native: false,
    };
  }
  // A pick the VM no longer lists drops only that agent. Refuse when nothing resolves, so a
  // broken catalog cannot prune every existing definition.
  const resolvable = chosen.filter(id => entries[id]);
  if (chosen.length > 0 && resolvable.length === 0) invalid();
  onSkipped?.(chosen.filter(id => !entries[id]));
  // Require the allowlisted policy extension, never guess from local OCX settings.
  if (!record(input.claudeCode)) invalid();
  const policy = input.claudeCode;
  const claudeCode: OcxClaudeCodeConfig = { nativePassthrough: false };
  for (const key of ["enabled", "injectAgents", "autoContext"] as const) {
    if (policy[key] !== undefined) {
      if (typeof policy[key] !== "boolean") invalid();
      claudeCode[key] = policy[key];
    }
  }
  for (const key of ["autoCompactWindow", "maxContextTokens"] as const) {
    const value = policy[key];
    if (value != null) {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 1_000_000) invalid();
      claudeCode[key] = value;
    }
  }
  if (policy.blockedSkills != null) {
    if (!Array.isArray(policy.blockedSkills) || !policy.blockedSkills.every(identifier)) invalid();
    claudeCode.blockedSkills = policy.blockedSkills as string[];
  }
  if (policy.modelMap != null) {
    if (!record(policy.modelMap) || !Object.entries(policy.modelMap).every(([key, value]) => identifier(key) && identifier(value))) invalid();
    claudeCode.modelMap = policy.modelMap as Record<string, string>;
  }
  const windows: Record<string, number> = Object.create(null);
  if (policy.contextWindows != null) {
    if (!record(policy.contextWindows)) invalid();
    for (const [key, value] of Object.entries(policy.contextWindows)) {
      if (!identifier(key) || typeof value !== "number" || !Number.isInteger(value) || value <= 0) invalid();
      windows[key] = value;
    }
  }
  const config = { port: 10100, defaultProvider: "openai", providers: {}, subagentModels: resolvable, claudeCode } as OcxConfig;
  if (claudeCode.enabled === false || claudeCode.injectAgents === false) return [];
  return buildClaudeAgentDefs(config, windows, configDir, { includeSelf: false, resolvedEntries: entries });
}

export function syncNotchAgentCatalog(input: unknown, configDir: string, onSkipped?: (ids: string[]) => void): string[] {
  const defs = buildNotchAgentDefs(input, configDir, onSkipped);
  // Check every selected target before writes; a user-authored collision is not success.
  for (const def of defs) {
    if (!/^ocx-[a-z0-9-]+\.md$/.test(def.file)) invalid();
    const path = join(configDir, "agents", def.file);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Could not inspect native agent targets; existing definitions retained.");
    }
    if (!stat.isFile() || !readFileSync(path, "utf8").includes("generated-by: opencodex")) {
      throw new Error("A selected agent conflicts with a user-owned file; existing definitions retained.");
    }
  }
  const written = syncClaudeAgentDefs(defs, configDir);
  if (!written || written.length !== defs.length) throw new Error("Could not synchronize native agent definitions.");
  return written;
}
