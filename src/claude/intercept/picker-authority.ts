import { X509Certificate } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";
import { createCertificateAuthority, acceptsCertificateAuthority, type LocalInterceptCa } from "./local-ca";
import { decodePickerCaCredential, pickerCaConfigId, PICKER_CA_MAX_PAYLOAD_BYTES } from "./picker-ca-store";
import { pickerDerFingerprint } from "./picker-trust";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { withLocalCaPublicationLock } from "./publication-lock";

export const PICKER_CA_NAME = "opencodex Claude Code Picker CA";
const policy = { commonName: PICKER_CA_NAME, permittedDnsNames: ["claude.ai"], validityDays: 30 };
export const acceptsPickerAuthority = (pem: string): boolean => {
  try { return acceptsCertificateAuthority(new X509Certificate(pem), policy); } catch { return false; }
};

/** Signing material is persisted only as CurrentUser DPAPI ciphertext, never a PEM key. */
function protect(value: string, decrypt: boolean): string {
  const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;"
    + "$s=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($s);"
    + `$o=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);`
    + "[Console]::Out.Write([Convert]::ToBase64String($o))";
  const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    stdin: Buffer.from(value, "utf8"), stdout: "pipe", stderr: "ignore", timeout: 10_000, windowsHide: true,
  });
  const output = result.stdout.toString().trim();
  if (!result.success || output.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw new Error("picker_ca_store_unavailable");
  return output;
}

export function ensurePickerAuthority(configDir: string, removalOnly = false): LocalInterceptCa {
  if (process.platform !== "win32") throw new Error("picker_platform_unsupported");
  const directory = lstatSync(configDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("picker_ca_store_invalid");
  return withLocalCaPublicationLock(() => {
    const configId = pickerCaConfigId(realpathSync(configDir));
    const path = join(configDir, "picker-ca.dpapi");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error("picker_ca_store_invalid");
      const bytes = readFileSync(path);
      if (bytes.length > 64 * 1024) throw new Error("picker_ca_store_invalid");
      const raw = Buffer.from(protect(bytes.toString(), true), "base64").toString("utf8");
      let stored;
      if (removalOnly) {
        // Cleanup must use the exact protected identity even after expiry; never issue a new root.
        const document = JSON.parse(raw);
        const certificate = new X509Certificate(document.certPem);
        const at = Date.parse(certificate.validFrom) + 1;
        stored = decodePickerCaCredential(raw, configId, pem => acceptsCertificateAuthority(new X509Certificate(pem), policy, at), at);
      } else stored = decodePickerCaCredential(raw, configId, acceptsPickerAuthority);
      if (!removalOnly) atomicWriteFile(join(configDir, "picker-ca.pem"), stored.certPem);
      return { ...stored, permittedDnsNames: ["claude.ai"] };
    }
    if (removalOnly) throw new Error("picker_ca_store_missing");
    const ca = createCertificateAuthority(policy);
    const raw = JSON.stringify({ schema: 1, configId, certPem: new X509Certificate(ca.certPem).toString(), keyPem: ca.keyPem, fingerprint: pickerDerFingerprint(ca.certPem) });
    if (Buffer.byteLength(raw) > PICKER_CA_MAX_PAYLOAD_BYTES) throw new Error("picker_ca_store_invalid");
    decodePickerCaCredential(raw, configId, acceptsPickerAuthority);
    const encrypted = protect(Buffer.from(raw).toString("base64"), false);
    atomicWriteFile(path, encrypted);
    if (Buffer.from(protect(readFileSync(path, "utf8"), true), "base64").toString("utf8") !== raw) throw new Error("picker_ca_store_readback_failed");
    atomicWriteFile(join(configDir, "picker-ca.pem"), ca.certPem);
    return ca;
  }, { lockPath: join(configDir, "picker-publication.sqlite") });
}
