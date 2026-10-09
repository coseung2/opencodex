import type { OcxConfig } from "../types";
import { routeModel } from "../router";
import { resolveInboundModel } from "./inbound";

/** Request-local Anthropic TTL. Never changes the shared config or other providers. */
export function claudeCacheRetention(config: OcxConfig, raw: unknown): OcxConfig["cacheRetention"] {
  if (config.cacheRetention !== undefined) return config.cacheRetention;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  if (typeof body.model !== "string") return undefined;
  let provider;
  try { provider = routeModel(config, resolveInboundModel(body.model, config.claudeCode)).provider; }
  catch { return undefined; }
  if (provider.adapter !== "anthropic") return undefined;
  const ttls = new Set<string>();
  const visit = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const cc = block.cache_control;
      if (cc?.type === "ephemeral" && (cc.ttl === "1h" || cc.ttl === "5m")) ttls.add(cc.ttl);
      if (block.type === "tool_result") visit(block.content);
    }
  };
  visit(body.system); visit(body.tools);
  if (Array.isArray(body.messages)) for (const msg of body.messages) visit(msg?.content);
  const top = body.cache_control as { type?: string; ttl?: string } | undefined;
  if (top?.type === "ephemeral" && (top.ttl === "1h" || top.ttl === "5m")) ttls.add(top.ttl);
  // The translated wire has one retention policy: honor the shorter explicit
  // lifetime on mixed-TTL input rather than silently extending billed writes.
  if (ttls.has("5m")) return "short";
  if (ttls.has("1h")) return "long";
  // Subscription Claude sessions get an hour; API-key billing keeps its default.
  return provider.authMode === "oauth" ? "long" : undefined;
}
