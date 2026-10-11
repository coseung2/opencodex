// Budget contract adapted from MIT upstream d17a9f2239031df31d978f1419f326142c00d88b.
export const PICKER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Bounded traversal measures JSON without allocating a complete serialized payload. */
export function pickerJsonBytes(value: unknown, cap: number): number {
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const add = (n: number) => { bytes += n; if (bytes > cap) throw new RangeError("Picker rewrite byte limit"); };
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 200000 || depth > 64) throw new RangeError("Picker rewrite complexity limit");
    if (v === null || typeof v === "boolean" || typeof v === "number") { add(Buffer.byteLength(JSON.stringify(v))); return; }
    if (typeof v === "string") { if (v.length > cap) throw new RangeError("Picker rewrite byte limit"); add(Buffer.byteLength(JSON.stringify(v))); return; }
    if (typeof v !== "object" || active.has(v)) throw new RangeError("Picker unsupported JSON");
    active.add(v); add(2);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { if (i) add(1); visit(v[i] === undefined ? null : v[i], depth + 1); }
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new RangeError("Picker unsupported JSON");
      let count = 0;
      for (const key of Object.keys(v)) {
        const desc = Object.getOwnPropertyDescriptor(v, key)!;
        if (!("value" in desc)) throw new RangeError("Picker unsupported JSON");
        if (desc.value === undefined) continue;
        if (count++) add(1); visit(key, depth + 1); add(1); visit(desc.value, depth + 1);
      }
    }
    active.delete(v);
  };
  visit(value, 0); return bytes;
}
export function pickerRowBytes(row: Record<string, unknown>): number {
  for (const key of Object.keys(row)) {
    pickerJsonBytes(key, 64 * 1024);
    if (row[key] !== undefined) pickerJsonBytes(row[key], 64 * 1024);
  }
  return pickerJsonBytes(row, 256 * 1024);
}
export class PickerRewriteBudget {
  private outputBytes: number;
  private addedBytes = 0;
  private addedRows = 0;
  constructor(body: unknown) { this.outputBytes = pickerJsonBytes(body, PICKER_MAX_OUTPUT_BYTES); }
  reserveBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2 * 1024 * 1024 - this.addedBytes || bytes > PICKER_MAX_OUTPUT_BYTES - this.outputBytes) throw new RangeError("Picker rewrite byte limit");
    this.outputBytes += bytes; this.addedBytes += bytes;
  }
  reserveRow(row: Record<string, unknown>): void {
    if (++this.addedRows > 4096) throw new RangeError("Picker rewrite row limit");
    this.reserveBytes(pickerRowBytes(row) + 1);
  }
}
