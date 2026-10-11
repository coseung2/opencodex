import type { OcxClaudeCodeConfig } from "../types";
import { extractOcxRouteDirective, resolveInboundModel } from "./inbound";
import { stripOneMillionMarker } from "./context-windows";
import type { FirstPartyCatalogSnapshot } from "./first-party-catalog";

export type FirstPartyRouteDecision =
  | { kind: "native" }
  | { kind: "routed"; model: string }
  | { kind: "unavailable"; reason: "catalog_unavailable" | "catalog_stale" | "route_not_available" | "invalid_request" };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function isNativeModel(model: string): boolean { return /^(?:claude|anthropic)/i.test(model); }

/** Same resolver/directive precedence as the VM; native credentials never decide a routed destination. */
export function selectFirstPartyRoute(
  body: unknown,
  policy: Pick<OcxClaudeCodeConfig, "modelMap">,
  catalog?: FirstPartyCatalogSnapshot | null,
  now = Date.now(),
  requireCatalog = false,
): FirstPartyRouteDecision {
  if (!record(body) || typeof body.model !== "string" || !body.model) return { kind: "unavailable", reason: "invalid_request" };
  const incoming = stripOneMillionMarker(body.model);
  const directive = extractOcxRouteDirective(body);
  const requested = directive ?? incoming;
  const model = resolveInboundModel(requested, policy);
  if (!directive && model === incoming && isNativeModel(incoming)) return { kind: "native" };
  if (!requireCatalog) return { kind: "routed", model };
  if (!catalog) return { kind: "unavailable", reason: "catalog_unavailable" };
  if (catalog.expiresAt < now) return { kind: "unavailable", reason: "catalog_stale" };
  if (!catalog.models.some(row => row.route === model || row.id === requested)
    && !Object.values(catalog.modelMap).includes(model)) return { kind: "unavailable", reason: "route_not_available" };
  return { kind: "routed", model };
}
