import { expect, test } from "bun:test";
import { inspectPickerTrust, pickerDerFingerprint, trustPickerCa, untrustPickerCa, trustedPickerPowerShellPath, type TrustedPickerRunner } from "../src/claude/intercept/picker-trust";
import { decodePickerCaCredential, openPickerCaCredential, pickerCaConfigId, readPickerCaCredential, readProtectedPickerCa } from "../src/claude/intercept/picker-ca-store";
// Public certificate only; private signing key was discarded during fixture generation.
const pem = `-----BEGIN CERTIFICATE-----
MIIBjDCCATOgAwIBAgIUEWcUi+4IYW4YuPAbbq+YxOKXl5swCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRRml4dHVyZSBQaWNrZXIgQ0EwHhcNMjYxMDEwMDYwODQ4WhcN
MzYxMDA3MDYwODQ4WjAcMRowGAYDVQQDDBFGaXh0dXJlIFBpY2tlciBDQTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABChfEeSNgX7qLts1MZNcf3xiOIanDrABneyu
1J5YJ67n6arpCXtvmg/pM+Om78VjWXNLUcJf9uJ3E2kKmdPtpQSjUzBRMB0GA1Ud
DgQWBBRi1/1IOakSZuzEPtZvHRTxozOIIjAfBgNVHSMEGDAWgBRi1/1IOakSZuzE
PtZvHRTxozOIIjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIGkE
d5+AhIHkb53x0qEU/PDKg6RgN+fD0cbl4zwGYJo9AiBs8iyG9hSyfflzCztWhT9t
IkzLsHfGWPyS9xf4bseZEg==
-----END CERTIFICATE-----`;
test("Windows inspect is DER fingerprint anchored, read-only and trusted executable scoped", async () => {
  let script = "", executable = "";
  const run: TrustedPickerRunner = async (exe, args) => { executable = exe; script = Buffer.from(args[args.length - 1]!, "base64").toString("utf16le"); return { code: 0, stdout: "trusted", stderr: "" }; };
  expect(await inspectPickerTrust(pem, { platform: "win32", windowsDirectory: "C:\\Windows", run })).toBe("trusted");
  expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  expect(script).toContain(pickerDerFingerprint(pem)); expect(script).toContain("CurrentUser"); expect(script).toContain("ReadOnly");
  expect(script).not.toContain("LocalMachine"); expect(script).not.toContain("Fixture Picker CA"); expect(script).not.toContain("$store.Add");
  expect(() => trustedPickerPowerShellPath("C:\\untrusted")).toThrow();
});
test("Windows trust/untrust never invokes runner without explicit user action", async () => {
  let calls = 0;
  const run: TrustedPickerRunner = async (_exe, args) => { calls++; const script = Buffer.from(args[args.length - 1]!, "base64").toString("utf16le"); expect(script).toContain("CurrentUser"); return { code: 0, stdout: "ok", stderr: "" }; };
  const options = { platform: "win32" as const, windowsDirectory: "C:\\Windows", run };
  expect(await trustPickerCa(pem, options)).toEqual({ ok: false, reason: "user_action_required" });
  expect(await untrustPickerCa(pem, options)).toEqual({ ok: false, reason: "user_action_required" }); expect(calls).toBe(0);
  expect(await trustPickerCa(pem, { ...options, userAction: true })).toEqual({ ok: true });
  expect(await untrustPickerCa(pem, { ...options, userAction: true })).toEqual({ ok: true }); expect(calls).toBe(2);
});
test("unsupported platforms and runner failure do not claim trust or expose diagnostics", async () => {
  const run: TrustedPickerRunner = async () => { throw new Error("fixture-sensitive-output"); };
  expect(await inspectPickerTrust(pem, { platform: "linux", run })).toBe("unsupported");
  expect(await inspectPickerTrust(pem, { platform: "win32", run, windowsDirectory: "C:\\Windows" })).toBe("unknown");
  expect(await trustPickerCa(pem, { platform: "win32", run, windowsDirectory: "C:\\Windows", userAction: true })).toEqual({ ok: false, reason: "declined_or_failed" });
});
test("credential adapters validate boundaries and normalize secret-bearing failures", async () => {
  const id = pickerCaConfigId("/fixture/canonical-config"); expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(openPickerCaCredential(id, (service, account) => { expect(service).toContain("picker.ca"); expect(account).toBe(id); return { getPassword: () => null, setPassword: () => {} }; }).getPassword()).toBeNull();
  for (const raw of ["{}", "[]", "fixture-private-key", "x".repeat(17000), JSON.stringify({ schema: 1, configId: id, fingerprint: "A".repeat(64), certPem: pem, keyPem: "fixture-private-key" })]) {
    expect(() => decodePickerCaCredential(raw, id, () => true, 1800000000000)).toThrow("picker_ca_store_invalid");
  }
  expect(() => readPickerCaCredential({ getPassword: () => { throw new Error("fixture-private-key"); }, setPassword: () => {} })).toThrow("picker_ca_store_unavailable");
  expect(await readProtectedPickerCa(id, { read: async () => null, write: async () => {} })).toBeNull();
  await expect(readProtectedPickerCa(id, { read: async () => { throw new Error("fixture-private-key"); }, write: async () => {} })).rejects.toThrow("picker_ca_store_unavailable");
});
