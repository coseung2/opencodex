import { desktop3pAlias } from "./desktop-3p";
export interface PickerPresentationSource { id: string; route: string; name: string; effortLevels: readonly string[]; contextWindow?: number }

/** First-party pickers require a recognized Claude family, unlike gateway discovery. */
export function pickerPresentationModels<T extends PickerPresentationSource>(rows: readonly T[]): Array<T & { sourceId: string }> {
  const candidates = rows.map(row => {
    const slash = row.route.indexOf("/");
    const provider = slash < 0 ? "native" : row.route.slice(0, slash);
    const model = slash < 0 ? row.route : row.route.slice(slash + 1);
    return { ...row, sourceId: row.id, id: desktop3pAlias(provider, model) };
  });
  const owners = new Map<string, Set<string>>();
  for (const row of candidates) {
    const routes = owners.get(row.id) ?? new Set<string>();
    routes.add(row.route); owners.set(row.id, routes);
  }
  // A short-code collision must hide the ambiguous row, never silently route it
  // to whichever provider happened to be enumerated first.
  const emitted = new Set<string>();
  return candidates.filter(row => {
    if (owners.get(row.id)!.size !== 1 || emitted.has(row.id)) return false;
    emitted.add(row.id); return true;
  });
}
