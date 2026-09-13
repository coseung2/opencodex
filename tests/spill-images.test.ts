import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { encodeSpillImages, decodeSpillImages, releaseSpillImages } from "../src/responses/spill-images";

test("shared images occupy one row and survive removal of a sibling snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "spill-images-"));
  try {
    const image = "data:image/png;base64," + "A".repeat(100_000);
    const original = JSON.stringify({ version: 1, items: [{ image_url: image }, { text: 'quoted "data:image/not-an-image"' }] });
    const first = encodeSpillImages(original, "a".repeat(32), dir);
    const second = encodeSpillImages(original, "b".repeat(32), dir);
    expect(first.length).toBeLessThan(1000);
    const db = new Database(join(dir, "images.sqlite"), { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM images").get()).toEqual({ n: 1 });
    db.close();
    expect(decodeSpillImages(first, dir, 200_000)).toBe(original);
    releaseSpillImages(first, dir);
    expect(decodeSpillImages(second, dir, 200_000)).toBe(original);
    expect(() => decodeSpillImages(second, dir, 100)).toThrow();
    releaseSpillImages(second, dir);
    expect(() => decodeSpillImages(second, dir, 200_000)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy snapshots and escaped image-like text round-trip without reinterpretation", () => {
  const dir = mkdtempSync(join(tmpdir(), "spill-images-"));
  try {
    const original = JSON.stringify({ version: 1, items: [{ text: 'prefix "data:image/png;' + 'x'.repeat(5000) + '"' }] });
    expect(encodeSpillImages(original, "c".repeat(32), dir)).toBe(original);
    expect(decodeSpillImages(original, dir, 10000)).toBe(original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
