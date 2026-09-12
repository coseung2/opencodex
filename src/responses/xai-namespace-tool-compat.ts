import { createHash } from "node:crypto";
import { namespacedToolName } from "../types";
import type { SsePayloadRewrite } from "../server/sse-payload-rewrite";

interface NamespacedToolIdentity {
  namespace: string;
  name: string;
}

interface NamespaceAliasPlan {
  byIdentity: Map<string, string>;
  responseAliases: Map<string, NamespacedToolIdentity>;
  clientSpellings: Map<string, string | null>;
}

const BUILTIN_FUNCTIONS_NAMESPACE = "functions";
const MAX_XAI_FUNCTION_NAME_LENGTH = 64;
const XAI_FUNCTION_NAME = /^[A-Za-z0-9_-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function identityKey(namespace: string, name: string): string {
  return `${namespace}\0${name}`;
}

function toolContainers(body: unknown): unknown[][] {
  if (!isPlainObject(body)) return [];
  const groups: unknown[][] = [];
  if (Array.isArray(body.tools)) groups.push(body.tools);
  if (!Array.isArray(body.input)) return groups;
  for (const item of body.input) {
    if (!isPlainObject(item) || !Array.isArray(item.tools)) continue;
    if (item.type === "additional_tools" || item.type === "tool_search_output") groups.push(item.tools);
  }
  return groups;
}

function collectDeclarations(body: unknown): {
  directNames: Set<string>;
  identities: Map<string, NamespacedToolIdentity>;
} {
  const directNames = new Set<string>();
  const identities = new Map<string, NamespacedToolIdentity>();

  for (const group of toolContainers(body)) {
    for (const tool of group) {
      if (!isPlainObject(tool)) continue;
      if ((tool.type === "function" || tool.type === "custom") && typeof tool.name === "string") {
        directNames.add(tool.name);
        continue;
      }
      if (tool.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) continue;
      if (tool.name === BUILTIN_FUNCTIONS_NAMESPACE) {
        for (const inner of tool.tools) {
          if (isPlainObject(inner) && typeof inner.name === "string") directNames.add(inner.name);
        }
        continue;
      }
      for (const inner of tool.tools) {
        if (!isPlainObject(inner) || inner.type !== "function" || typeof inner.name !== "string") continue;
        const identity = { namespace: tool.name, name: inner.name };
        identities.set(identityKey(identity.namespace, identity.name), identity);
      }
    }
  }

  if (isPlainObject(body) && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        !isPlainObject(item)
        || item.type !== "function_call"
        || typeof item.namespace !== "string"
        || typeof item.name !== "string"
        || item.namespace === BUILTIN_FUNCTIONS_NAMESPACE
      ) continue;
      const identity = { namespace: item.namespace, name: item.name };
      identities.set(identityKey(identity.namespace, identity.name), identity);
    }
  }
  if (
    isPlainObject(body)
    && isPlainObject(body.tool_choice)
    && typeof body.tool_choice.namespace === "string"
    && typeof body.tool_choice.name === "string"
    && body.tool_choice.namespace !== BUILTIN_FUNCTIONS_NAMESPACE
  ) {
    const identity = { namespace: body.tool_choice.namespace, name: body.tool_choice.name };
    identities.set(identityKey(identity.namespace, identity.name), identity);
  }

  return { directNames, identities };
}

function hashedAlias(identity: NamespacedToolIdentity, occupied: ReadonlySet<string>): string {
  let salt = 0;
  while (true) {
    const digest = createHash("sha256")
      .update(`${identity.namespace}\0${identity.name}\0${salt}`)
      .digest("hex")
      .slice(0, 40);
    const alias = `ocxns_${digest}`;
    if (!occupied.has(alias)) return alias;
    salt += 1;
  }
}

function claimClientSpelling(
  spellings: Map<string, string | null>,
  spelling: string,
  key: string,
): void {
  if (!spellings.has(spelling)) {
    spellings.set(spelling, key);
    return;
  }
  if (spellings.get(spelling) !== key) spellings.set(spelling, null);
}

function buildAliasPlan(body: unknown): NamespaceAliasPlan {
  const { directNames, identities } = collectDeclarations(body);
  const occupied = new Set(directNames);
  const byIdentity = new Map<string, string>();
  const responseAliases = new Map<string, NamespacedToolIdentity>();
  const clientSpellings = new Map<string, string | null>();

  for (const directName of directNames) clientSpellings.set(directName, null);
  for (const [key, identity] of identities) {
    claimClientSpelling(clientSpellings, namespacedToolName(identity.namespace, identity.name), key);
    claimClientSpelling(clientSpellings, `${identity.namespace}.${identity.name}`, key);
  }

  for (const key of [...identities.keys()].sort()) {
    const identity = identities.get(key)!;
    const preferred = namespacedToolName(identity.namespace, identity.name);
    const alias = XAI_FUNCTION_NAME.test(preferred)
      && preferred.length <= MAX_XAI_FUNCTION_NAME_LENGTH
      && !occupied.has(preferred)
      ? preferred
      : hashedAlias(identity, occupied);
    occupied.add(alias);
    byIdentity.set(key, alias);
    responseAliases.set(alias, identity);
  }

  return { byIdentity, responseAliases, clientSpellings };
}

function aliasForIdentity(plan: NamespaceAliasPlan, namespace: string, name: string): string | undefined {
  return plan.byIdentity.get(identityKey(namespace, name));
}

function aliasForClientSpelling(plan: NamespaceAliasPlan, name: string): string | undefined {
  const key = plan.clientSpellings.get(name);
  return typeof key === "string" ? plan.byIdentity.get(key) : undefined;
}

function stripDeferredLoading(tool: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(tool, "defer_loading")) return tool;
  const { defer_loading: _deferLoading, ...rest } = tool;
  return rest;
}

function flattenNamespaceTool(tool: Record<string, unknown>, plan: NamespaceAliasPlan): unknown[] | undefined {
  if (tool.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) return undefined;
  const namespace = tool.name;
  const flattened: unknown[] = [];

  for (const inner of tool.tools) {
    if (!isPlainObject(inner)) {
      flattened.push(inner);
      continue;
    }
    if (namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
      flattened.push(inner.type === "function" ? stripDeferredLoading(inner) : inner);
      continue;
    }
    if (inner.type === "function" && typeof inner.name === "string") {
      const alias = aliasForIdentity(plan, namespace, inner.name);
      flattened.push(alias ? { ...stripDeferredLoading(inner), name: alias } : stripDeferredLoading(inner));
      continue;
    }
    // xAI cannot accept the namespace wrapper itself. Preserve unknown inner tool kinds at top level
    // so a future/unsupported kind fails on its own type instead of the already-known namespace type.
    flattened.push(inner);
  }
  return flattened;
}

function rewriteToolGroup(group: unknown[], plan: NamespaceAliasPlan): { group: unknown[]; changed: boolean } {
  let changed = false;
  const next: unknown[] = [];
  for (const tool of group) {
    if (!isPlainObject(tool)) {
      next.push(tool);
      continue;
    }
    const flattened = flattenNamespaceTool(tool, plan);
    if (flattened) {
      changed = true;
      next.push(...flattened);
      continue;
    }
    next.push(tool);
  }
  return changed ? { group: next, changed: true } : { group, changed: false };
}

function rewriteFunctionCall(item: Record<string, unknown>, plan: NamespaceAliasPlan): Record<string, unknown> {
  if (item.type !== "function_call" || typeof item.name !== "string") return item;
  let alias: string | undefined;
  if (typeof item.namespace === "string") {
    alias = aliasForIdentity(plan, item.namespace, item.name);
  } else {
    alias = aliasForClientSpelling(plan, item.name);
  }
  if (!alias && typeof item.namespace !== "string") return item;
  const next = { ...item };
  if (alias) next.name = alias;
  delete next.namespace;
  return next;
}

function rewriteToolChoiceEntry(entry: unknown, plan: NamespaceAliasPlan): unknown {
  if (!isPlainObject(entry) || typeof entry.name !== "string") return entry;
  let alias: string | undefined;
  if (typeof entry.namespace === "string") alias = aliasForIdentity(plan, entry.namespace, entry.name);
  else alias = aliasForClientSpelling(plan, entry.name);
  if (!alias && typeof entry.namespace !== "string") return entry;
  const next = { ...entry };
  if (alias) next.name = alias;
  delete next.namespace;
  return next;
}

function rewriteToolChoice(value: unknown, plan: NamespaceAliasPlan): unknown {
  if (!isPlainObject(value)) return value;
  if ((value.type === "function" || value.type === "custom") && typeof value.name === "string") {
    return rewriteToolChoiceEntry(value, plan);
  }
  if (value.type !== "allowed_tools" || !Array.isArray(value.tools)) return value;
  let changed = false;
  const tools = value.tools.map(entry => {
    const rewritten = rewriteToolChoiceEntry(entry, plan);
    changed ||= rewritten !== entry;
    return rewritten;
  });
  return changed ? { ...value, tools } : value;
}

/**
 * Return the exact upstream aliases used for Codex namespace tools on xAI Responses. The same plan
 * is recomputed at the client-facing response boundary so function calls can be restored without
 * guessing by separators.
 */
export function xaiResponsesNamespaceToolAliases(body: unknown): Map<string, NamespacedToolIdentity> {
  return buildAliasPlan(body).responseAliases;
}

/**
 * Lower Codex private `namespace` tool declarations to xAI-compatible flat function declarations.
 * Ordinary built-ins grouped under the synthetic `functions` namespace remain bare. Real namespaces
 * use their canonical `<namespace>__<name>` spelling when it is safe and collision-free, otherwise
 * a deterministic opaque alias. Replayed function calls and explicit tool selectors follow the same
 * mapping. The original body is never mutated.
 */
export function lowerXaiResponsesNamespaceTools(body: unknown): { body: unknown; aliases: Map<string, NamespacedToolIdentity> } {
  if (!isPlainObject(body)) return { body, aliases: new Map() };
  const plan = buildAliasPlan(body);
  const hasNamespace = plan.byIdentity.size > 0
    || toolContainers(body).some(group => group.some(tool => isPlainObject(tool) && tool.type === "namespace"));
  if (!hasNamespace) return { body, aliases: plan.responseAliases };

  let changed = false;
  let tools = body.tools;
  if (Array.isArray(body.tools)) {
    const rewritten = rewriteToolGroup(body.tools, plan);
    tools = rewritten.group;
    changed ||= rewritten.changed;
  }

  let input = body.input;
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const rewrittenInput = body.input.map(item => {
      if (!isPlainObject(item)) return item;
      let next = rewriteFunctionCall(item, plan);
      if (Array.isArray(next.tools) && (next.type === "additional_tools" || next.type === "tool_search_output")) {
        const rewritten = rewriteToolGroup(next.tools, plan);
        if (rewritten.changed) next = { ...next, tools: rewritten.group };
      }
      inputChanged ||= next !== item;
      return next;
    });
    if (inputChanged) {
      input = rewrittenInput;
      changed = true;
    }
  }

  const toolChoice = rewriteToolChoice(body.tool_choice, plan);
  changed ||= toolChoice !== body.tool_choice;

  if (!changed) return { body, aliases: plan.responseAliases };
  return {
    body: {
      ...body,
      ...(Array.isArray(body.tools) ? { tools } : {}),
      ...(Array.isArray(body.input) ? { input } : {}),
      ...(Object.hasOwn(body, "tool_choice") ? { tool_choice: toolChoice } : {}),
    },
    aliases: plan.responseAliases,
  };
}

function restoreNamespaceCalls(value: unknown, aliases: ReadonlyMap<string, NamespacedToolIdentity>): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(entry => {
      const restored = restoreNamespaceCalls(entry, aliases);
      changed ||= restored !== entry;
      return restored;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const restored = restoreNamespaceCalls(entry, aliases);
    next[key] = restored;
    changed ||= restored !== entry;
  }

  const target = value.type === "function_call" && typeof value.name === "string"
    ? aliases.get(value.name)
    : undefined;
  if (target && (value.namespace === undefined || value.namespace === target.namespace)) {
    next.name = target.name;
    next.namespace = target.namespace;
    changed = true;
  }
  return changed ? next : value;
}

/** Restore xAI flat function calls to the namespace/name identity Codex originally declared. */
export function restoreXaiNamespaceCallsInJson(
  text: string,
  aliases: ReadonlyMap<string, NamespacedToolIdentity>,
): string {
  if (aliases.size === 0) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    const restored = restoreNamespaceCalls(parsed, aliases);
    return restored === parsed ? text : JSON.stringify(restored);
  } catch {
    return text;
  }
}

/** Client-facing SSE rewrite for xAI namespace aliases. */
export function createXaiNamespaceToolPayloadRewrite(
  aliases: ReadonlyMap<string, NamespacedToolIdentity>,
): SsePayloadRewrite | undefined {
  if (aliases.size === 0) return undefined;
  return payload => restoreXaiNamespaceCallsInJson(payload, aliases);
}
