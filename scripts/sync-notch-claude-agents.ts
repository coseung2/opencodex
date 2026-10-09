import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { syncNotchAgentCatalog } from "../src/claude/notch-agent-sync";

const args = process.argv.slice(2);
const hook = args.includes("--hook");
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("Missing synchronization option value.");
  return value;
}
let lock: string | undefined;
let fd: number | undefined;
let scratch: string | undefined;
try {
  const configDir = option("--config-dir") ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  mkdirSync(configDir, { recursive: true });
  lock = join(configDir, ".notch-agent-sync.lock");
  try { fd = openSync(lock, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (!hook) console.log("Native agent synchronization already running.");
      process.exit(0);
    }
    throw new Error("Could not lock native agent synchronization.");
  }
  const fixture = option("--catalog");
  let text: string;
  if (fixture) {
    text = readFileSync(fixture, "utf8");
  } else {
    const binary = option("--notch-binary");
    if (!binary) throw new Error("A metadata-capable Notch binary is required.");
    scratch = mkdtempSync(join(tmpdir(), "ocx-native-agents-"));
    const output = join(scratch, "catalog.json");
    const result = spawnSync(binary, ["--subagent-catalog-output", output], {
      timeout: 40_000, windowsHide: true, encoding: "utf8", maxBuffer: 1_048_576,
    });
    // Native stderr can contain private connection details; never relay it.
    if (result.error || result.status !== 0) throw new Error("VM Notch catalog query failed; existing definitions retained.");
    text = readFileSync(output, "utf8");
  }
  if (text.length > 2_097_152) throw new Error("VM catalog exceeds the synchronization limit.");
  let catalog: unknown;
  try { catalog = JSON.parse(text); } catch { throw new Error("Invalid VM catalog JSON; existing definitions retained."); }
  const files = syncNotchAgentCatalog(catalog, configDir);
  if (!hook) console.log(JSON.stringify({ source: "remote", count: files.length, agents: files }));
} catch (error) {
  const message = error instanceof Error && !/(?:[A-Za-z]:\\|https?:\/\/)/.test(error.message)
    ? error.message : "VM native agent synchronization failed; existing definitions retained.";
  if (hook) console.log(JSON.stringify({ systemMessage: `OCX: ${message}` }));
  else { console.error(message); process.exitCode = 1; }
} finally {
  if (fd !== undefined) {
    closeSync(fd);
    if (lock) try { unlinkSync(lock); } catch { /* do not remove another lock */ }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
