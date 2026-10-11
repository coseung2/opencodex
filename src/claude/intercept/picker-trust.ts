import { createHash, X509Certificate } from "node:crypto";
import { win32, join } from "node:path";
export type PickerTrustState = "trusted" | "untrusted" | "unsupported" | "unknown";
export interface SecurityResult { code: number | null; stdout: string; stderr: string }
/** Must execute the supplied absolute trusted executable without shell/PATH resolution. */
export type TrustedPickerRunner = (executable: string, args: readonly string[]) => Promise<SecurityResult>;
export interface PickerTrustOptions {
  platform: NodeJS.Platform;
  run: TrustedPickerRunner;
  /** Explicit injected OS root; not read from process.env. */
  windowsDirectory?: string;
  home?: string;
  userAction?: boolean;
}
export function trustedPickerPowerShellPath(windowsDirectory: string): string {
  if (!/^[A-Za-z]:[\\/]Windows$/i.test(windowsDirectory)) throw new Error("picker_trusted_runner_unavailable");
  return win32.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
export function pickerDerFingerprint(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex").toUpperCase();
}
const sha1 = (pem: string) => createHash("sha1").update(new X509Certificate(pem).raw).digest("hex").toUpperCase();
function certBytes(pem: string): string { if (Buffer.byteLength(pem) > 16 * 1024) throw new Error("picker_ca_invalid"); return new X509Certificate(pem).raw.toString("base64"); }
function psArgs(script: string, interactive = false): string[] { return ["-NoLogo", "-NoProfile", ...(interactive ? [] : ["-NonInteractive"]), "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]; }
const hashScript = "$sha=[Security.Cryptography.SHA256]::Create();function Fingerprint($c){[BitConverter]::ToString($sha.ComputeHash($c.RawData)).Replace('-','')}";
async function windowsTrust(pem: string, action: "inspect" | "install" | "remove", options: PickerTrustOptions): Promise<SecurityResult> {
  const fingerprint = pickerDerFingerprint(pem), der = certBytes(pem);
  const operation = action === "inspect" ? `if($found){'trusted'}else{'untrusted'}`
    : action === "install" ? `$cert=New-Object Security.Cryptography.X509Certificates.X509Certificate2(,[Convert]::FromBase64String('${der}'));if(-not $found){$store.Add($cert)};'ok'`
    : `foreach($cert in $found){$store.Remove($cert)};'ok'`;
  const flags = action === "inspect" ? "ReadOnly" : "ReadWrite";
  // No subject lookup, LocalMachine store, mutable PATH executable, file reads or interpolation of untrusted text.
  const script = `$ErrorActionPreference='Stop';${hashScript};$store=New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser');try{$store.Open('${flags}');$found=@($store.Certificates|Where-Object {(Fingerprint $_) -eq '${fingerprint}'});${operation}}finally{$store.Close()}`;
  // Windows owns any certificate confirmation dialog. Never suppress it on an explicit mutation.
  return options.run(trustedPickerPowerShellPath(options.windowsDirectory ?? ""), psArgs(script, action !== "inspect"));
}
export async function inspectPickerTrust(certPem: string, options: PickerTrustOptions): Promise<PickerTrustState> {
  try {
    if (options.platform === "win32") {
      const result = await windowsTrust(certPem, "inspect", options);
      return result.code === 0 && result.stdout.trim() === "trusted" ? "trusted" : result.code === 0 && result.stdout.trim() === "untrusted" ? "untrusted" : "unknown";
    }
    if (options.platform !== "darwin") return "unsupported";
    if (!options.home) return "unknown";
    const result = await options.run("/usr/bin/security", ["find-certificate", "-a", "-Z", join(options.home, "Library", "Keychains", "login.keychain-db")]);
    if (result.code === 1) return "untrusted";
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > 1024 * 1024) return "unknown";
    const expected = sha1(certPem);
    const found = result.stdout.split(/\r?\n/).some(line => /^SHA-1 hash:\s*([A-Fa-f0-9]{40})\s*$/.exec(line.trim())?.[1]?.toUpperCase() === expected);
    // Presence alone never proves macOS SSL trust. Caller needs verified leaf/policy inspection.
    return found ? "unknown" : "untrusted";
  } catch { return "unknown"; }
}
export type PickerTrustMutation = { ok: true } | { ok: false; reason: "user_action_required" | "unsupported" | "declined_or_failed" };
async function mutateTrust(certPem: string, action: "install" | "remove", options: PickerTrustOptions): Promise<PickerTrustMutation> {
  if (options.userAction !== true) return { ok: false, reason: "user_action_required" };
  if (options.platform !== "win32") return { ok: false, reason: "unsupported" };
  try { const result = await windowsTrust(certPem, action, options); return result.code === 0 && result.stdout.trim() === "ok" ? { ok: true } : { ok: false, reason: "declined_or_failed" }; }
  catch { return { ok: false, reason: "declined_or_failed" }; }
}
export function trustPickerCa(certPem: string, options: PickerTrustOptions): Promise<PickerTrustMutation> { return mutateTrust(certPem, "install", options); }
export function untrustPickerCa(certPem: string, options: PickerTrustOptions): Promise<PickerTrustMutation> { return mutateTrust(certPem, "remove", options); }
