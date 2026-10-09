import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = readFileSync(new URL("../packages/ocx-notch/assets/sync-claude-models.ps1", import.meta.url), "utf8");

test.skipIf(process.platform !== "win32")("Notch Claude labels use the applied gateway and preserve mismatched profiles", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-label-sync-"));
  const library = join(root, "profiles");
  mkdirSync(library);
  const id = "11111111-1111-4111-8111-111111111111";
  const profilePath = join(library, `${id}.json`);
  const runner = join(root, "runner.ps1");
  const profile = { inferenceProvider: "gateway", inferenceGatewayBaseUrl: "http://127.0.0.1:23456", inferenceGatewayApiKey: "offline-fixture", inferenceModels: [{ name: "old" }] };
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id }));
  writeFileSync(profilePath, JSON.stringify(profile));
  // Replace only transport with a local fixture: this test never uses a gateway or credentials.
  writeFileSync(runner, `function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec, $MaximumRedirection)
    if ($Uri -ne 'http://127.0.0.1:23456/v1/models?ids=desktop' -or $MaximumRedirection -ne 0) { throw 'Wrong discovery destination' }
    return @{ data = @(@{ id = 'claude-opus-5-5'; display_name = 'Offline fixture'; capabilities = @{ effort = @{ high = @{ supported = $true } } } }) }
}
& {\n${script}\n} -ConfigLibrary $args[0] -GatewayOrigin $args[1]
`);
  const run = (origin: string) => Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-File", runner, library, origin], { stdout: "pipe", stderr: "pipe" });
  try {
    const before = readFileSync(profilePath, "utf8");
    expect(run("http://127.0.0.1:9999").exitCode).not.toBe(0);
    expect(readFileSync(profilePath, "utf8")).toBe(before);
    const result = run(profile.inferenceGatewayBaseUrl);
    expect(result.exitCode).toBe(0);
    const updated = JSON.parse(readFileSync(profilePath, "utf8"));
    expect(updated.inferenceModels).toEqual([{ name: "claude-opus-5-5", labelOverride: "Offline fixture", anthropicFamilyTier: "opus", maxEffort: "high" }]);
    expect(updated.inferenceGatewayBaseUrl).toBe(profile.inferenceGatewayBaseUrl);
    expect(updated.modelDiscoveryEnabled).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
