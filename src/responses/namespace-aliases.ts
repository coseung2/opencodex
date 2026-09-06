import { namespacedToolName, type OcxTool } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";

export interface NamespacedToolIdentity { namespace: string; name: string }
type ToolIdentity = Pick<OcxTool, "namespace" | "name">;

function sameIdentity(left: ToolIdentity, right: ToolIdentity): boolean {
  return (left.namespace ?? "") === (right.namespace ?? "") && left.name === right.name;
}

/**
 * Resolve all ownership before publishing aliases. Dots may occur in both halves,
 * and a flat declaration can own a spelling which looks namespaced. Neither the
 * declaration order nor an ambiguous dotted name may choose a different tool.
 */
export function declaredNamespaceAliases(
  tools: readonly ToolIdentity[],
  budget?: TranslatorBudget,
): Map<string, NamespacedToolIdentity> {
  const owners = new Map<string, ToolIdentity | null>();
  const candidates = new Set<string>();
  let temporaryBytes = 0;
  const claim = (spelling: string, tool: ToolIdentity, candidate: boolean) => {
    if (!owners.has(spelling)) {
      const bytes = Buffer.byteLength(spelling) + Buffer.byteLength(tool.name)
        + Buffer.byteLength(tool.namespace ?? "") + 64;
      budget?.chargeRetained(bytes, { kind: "request_copies" });
      temporaryBytes += bytes;
      owners.set(spelling, tool);
    } else {
      const owner = owners.get(spelling);
      if (owner && !sameIdentity(owner, tool)) owners.set(spelling, null);
    }
    if (candidate) candidates.add(spelling);
  };
  try {
    for (const tool of tools) claim(namespacedToolName(tool.namespace, tool.name), tool, !!tool.namespace);
    for (const tool of tools) {
      if (!tool.namespace || tool.namespace.includes("__") || tool.name.includes("__")) continue;
      claim(`${tool.namespace}.${tool.name}`, tool, true);
    }
    const aliases = new Map<string, NamespacedToolIdentity>();
    for (const spelling of candidates) {
      const owner = owners.get(spelling);
      if (!owner?.namespace) continue;
      budget?.chargeRetained(
        Buffer.byteLength(spelling) + Buffer.byteLength(owner.namespace) + Buffer.byteLength(owner.name),
        { kind: "request_copies" },
      );
      aliases.set(spelling, { namespace: owner.namespace, name: owner.name });
    }
    return aliases;
  } finally {
    budget?.releaseRetained(temporaryBytes, { kind: "request_copies" });
  }
}
