import type { OcxConfig } from "../types";

// Request-only overrides must not own persisted account selection or pool policy.
const routingConfigOwners = new WeakMap<OcxConfig, OcxConfig>();

export function bindCodexRoutingConfig(replay: OcxConfig, source: OcxConfig): OcxConfig {
  const owner = codexRoutingConfig(source);
  if (replay !== owner) routingConfigOwners.set(replay, owner);
  return replay;
}

export function codexRoutingConfig(config: OcxConfig): OcxConfig {
  return routingConfigOwners.get(config) ?? config;
}
