/** Select an existing native menu, never invent an unsupported option or capability. */
type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const eligible = (row: Row) => typeof row.id === "string" && row.id.startsWith("claude-")
  && !row.disabled && !row.disabled_reason && row.section !== "deprecated";

export function pickerEffortTemplate(rows: readonly unknown[], levels: readonly string[] = []): Row | undefined {
  const candidates = rows.filter(record).filter(eligible);
  const score = (row: Row): number => {
    const thinking = record(row.thinking) && Array.isArray(row.thinking.effort_options)
      ? row.thinking.effort_options.filter(option => record(option) && typeof option.id === "string" && levels.includes(option.id)).length : 0;
    const ladders = [row.effort_levels, row.supported_effort_levels].reduce<number>((sum, value) =>
      sum + (Array.isArray(value) ? value.filter(level => typeof level === "string" && levels.includes(level)).length : 0), 0);
    return thinking + ladders;
  };
  // The first native row can be Haiku, with no thinking menu at all. Prefer the native
  // menu with the most verified overlap instead of silently deleting the routed menu.
  return candidates.reduce<Row | undefined>((best, row) => !best || score(row) > score(best) ? row : best, undefined);
}
