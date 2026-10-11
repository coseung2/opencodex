import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";
import { claudeDesktopConfigLibraryDir } from "../desktop-3p-paths";
import { withDesktopLifecycle } from "../desktop-lifecycle";

function read(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("picker_profile_unsafe");
    return readFileSync(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
interface Ownership { schema: 1; library: string; id: string; before: string; after: string; profile: string }
const safeId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
/** Exact-byte ownership and lifecycle serialization protect later user profile edits. */
export async function applyPickerProfile(configDir: string, pacUrl: string, library = claudeDesktopConfigLibraryDir()): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/ocx-claude-picker\.pac$/.test(pacUrl)) throw new Error("picker_profile_invalid_proxy");
  await withDesktopLifecycle(async () => {
    const metadataPath = join(library, "_meta.json"), manifestPath = join(configDir, "picker-profile.json");
    const existing = read(manifestPath);
    const before = read(metadataPath);
    if (before === null) throw new Error("picker_profile_missing");
    if (existing !== null) {
      const own = JSON.parse(existing) as Ownership;
      if (own.schema !== 1 || own.library !== library || !safeId(own.id) || before !== own.after || read(join(library, `${own.id}.json`)) !== own.profile
        || JSON.parse(own.profile).egressProxyPacUrl !== pacUrl) throw new Error("picker_profile_changed");
      return;
    }
    const directory = lstatSync(library);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("picker_profile_unsafe");
    const metadata = JSON.parse(before);
    if (!Array.isArray(metadata.entries) || !safeId(metadata.appliedId)) throw new Error("picker_profile_missing_selection");
    const selected = read(join(library, `${metadata.appliedId}.json`));
    const profile = selected === null ? null : JSON.parse(selected);
    const entry = metadata.entries.find((entry: { id?: string; name?: string }) => entry.id === metadata.appliedId);
    if (!profile || profile.inferenceProvider !== undefined || entry?.name !== "opencodex-standard"
      || profile.egressProxyUrl !== undefined || profile.egressProxyPacUrl !== undefined) throw new Error("picker_profile_foreign_selection");
    const id = randomUUID();
    const replacement = JSON.stringify({ ...profile, egressProxyPacUrl: pacUrl }, null, 2) + "\n";
    const after = JSON.stringify({ ...metadata, appliedId: id, entries: [...metadata.entries, { id, name: "opencodex-code-picker" }] }, null, 2) + "\n";
    const own: Ownership = { schema: 1, library, id, before, after, profile: replacement };
    atomicWriteFile(join(library, `${id}.json`), replacement);
    atomicWriteFile(manifestPath, JSON.stringify(own));
    if (read(metadataPath) !== before) throw new Error("picker_profile_changed");
    atomicWriteFile(metadataPath, after);
  });
}
export async function removePickerProfile(configDir: string, library = claudeDesktopConfigLibraryDir()): Promise<void> {
  await withDesktopLifecycle(async () => {
    const path = join(configDir, "picker-profile.json"), original = read(path);
    if (original === null) return;
    const own = JSON.parse(original) as Ownership;
    if (own.schema !== 1 || own.library !== library || !safeId(own.id)
      || read(join(library, "_meta.json")) !== own.after || read(join(library, `${own.id}.json`)) !== own.profile) throw new Error("picker_profile_changed");
    atomicWriteFile(join(library, "_meta.json"), own.before);
    unlinkSync(join(library, `${own.id}.json`));
    unlinkSync(path);
  });
}
