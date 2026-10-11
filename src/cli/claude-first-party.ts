import { runtimeRequest } from "./runtime-api";
import { findLiveProxy } from "../server/proxy-liveness";

export async function handleClaudeFirstPartyCommand(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || !["on", "off", "status"].includes(argv[0] ?? "")) {
    console.error("Usage: ocx claude first-party <on|off|status>");
    return 1;
  }
  if (!await findLiveProxy()) { console.error("Start the local OCX server first."); return 1; }
  try {
    if (argv[0] === "status") {
      const state = await runtimeRequest<{ cliFirstParty?: boolean }>("/api/claude-code");
      console.log(`Claude Code CLI first-party: ${state.cliFirstParty === true ? "on" : "off"}`);
      return 0;
    }
    const result = await runtimeRequest<{ ok: boolean; reason?: string }>("/api/claude-first-party/cli", {
      method: "POST", body: JSON.stringify({ enabled: argv[0] === "on" }),
    });
    if (!result.ok) { console.error(`CLI first-party change failed: ${result.reason ?? "unavailable"}`); return 1; }
    console.log(`Claude Code CLI first-party ${argv[0]}. Start a new Claude Code session when ready.`);
    return 0;
  } catch { console.error("CLI first-party change unavailable; inspect the local OCX status."); return 1; }
}
