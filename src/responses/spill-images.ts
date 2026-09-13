import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { hardenSecretPath } from "../lib/windows-secret-acl";

// Each snapshot owns links, not copies. Transactions publish image bytes before
// the snapshot file becomes visible; removing one owner cannot break a sibling.
const DB_NAME = "images.sqlite";
const DB_MAX_PAGES = 131_072; // 512 MiB at the fixed 4096-byte page size.
type Chunk = string | { image: string; bytes: number };
interface Envelope { version: 2; imageOwner: string; chunks: Chunk[] }
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

function open(dir: string): Database {
  const path = join(dir, DB_NAME);
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("Invalid image store");
  const db = new Database(path, { create: true });
  try {
    chmodSync(path, 0o600);
    if (process.platform === "win32" && !hardenSecretPath(path, { required: true }).ok) throw new Error("Image store permissions failed");
    db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${DB_MAX_PAGES}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;`);
    db.exec("CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owners (owner TEXT NOT NULL, image TEXT NOT NULL, PRIMARY KEY(owner,image)); CREATE INDEX IF NOT EXISTS owners_image ON owners(image);");
    return db;
  } catch (error) { db.close(); throw error; }
}

export function encodeSpillImages(serialized: string, owner: string, dir: string): string {
  const chunks: Chunk[] = [];
  const images = new Map<string, string>();
  let offset = 0;
  // Match JSON string tokens rather than arbitrary substrings inside text. The
  // JSON.stringify source escapes quotes and backslashes, so tokens round-trip.
  for (const match of serialized.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const token = match[0];
    if (!token.startsWith('"data:image/') || token.length < 4096) continue;
    chunks.push(serialized.slice(offset, match.index));
    const id = digest(token);
    images.set(id, token);
    chunks.push({ image: id, bytes: Buffer.byteLength(token) });
    offset = match.index + token.length;
  }
  if (!images.size) return serialized;
  chunks.push(serialized.slice(offset));
  const db = open(dir);
  try {
    db.transaction(() => {
      for (const [id, value] of images) {
        db.query("INSERT OR IGNORE INTO images VALUES (?,?)").run(id, value);
        db.query("INSERT OR IGNORE INTO owners VALUES (?,?)").run(owner, id);
      }
    })();
  } finally { db.close(); }
  return JSON.stringify({ version: 2, imageOwner: owner, chunks } satisfies Envelope);
}

export function decodeSpillImages(serialized: string, dir: string, cap: number): string {
  const envelope = JSON.parse(serialized) as Envelope;
  if (envelope?.version !== 2) return serialized;
  if (!/^[0-9a-f]{32}$/.test(envelope.imageOwner) || !Array.isArray(envelope.chunks)) throw new Error("Invalid image envelope");
  if (!existsSync(join(dir, DB_NAME))) throw new Error("Missing image store");
  const db = open(dir);
  try {
    let bytes = 0;
    const chunks = envelope.chunks.map(chunk => {
      if (typeof chunk === "string") {
        bytes += Buffer.byteLength(chunk);
        if (bytes > cap) throw new Error("Image replay exceeds limit");
        return chunk;
      }
      if (!chunk || !/^[0-9a-f]{64}$/.test(chunk.image) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0) throw new Error("Invalid image reference");
      bytes += chunk.bytes;
      if (bytes > cap) throw new Error("Image replay exceeds limit");
      const row = db.query("SELECT value FROM images JOIN owners ON images.id=owners.image WHERE owners.owner=? AND images.id=? AND length(CAST(value AS BLOB))=?").get(envelope.imageOwner, chunk.image, chunk.bytes) as { value: string } | null;
      if (!row || Buffer.byteLength(row.value) !== chunk.bytes || digest(row.value) !== chunk.image) throw new Error("Missing or corrupt image");
      return row.value;
    });
    return chunks.join("");
  } finally { db.close(); }
}

export function releaseSpillImages(serialized: string, dir: string): void {
  const envelope = JSON.parse(serialized) as Envelope;
  if (envelope?.version !== 2 || !/^[0-9a-f]{32}$/.test(envelope.imageOwner)) return;
  const db = open(dir);
  try {
    db.transaction(() => {
      db.query("DELETE FROM owners WHERE owner=?").run(envelope.imageOwner);
      db.exec("DELETE FROM images WHERE NOT EXISTS (SELECT 1 FROM owners WHERE owners.image=images.id)");
    })();
  } finally { db.close(); }
}
