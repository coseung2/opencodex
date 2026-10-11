// Exact-shape credential validation adapted from MIT upstream d17a9f2239031df31d978f1419f326142c00d88b.
import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
export const PICKER_CA_STORE_SERVICE = "opencodex.claude-desktop-picker.ca.v1";
export const PICKER_CA_MAX_PAYLOAD_BYTES = 16 * 1024;
export interface StoredPickerCa { certPem: string; keyPem: string; fingerprint: string; privateKey: KeyObject; publicKey: KeyObject }
export interface PickerCaCredential { getPassword(): string | null; setPassword(value: string): void }
export type PickerCaStore = (service: string, account: string) => PickerCaCredential;
export function pickerCaConfigId(canonicalConfigDir: string): string { return createHash("sha256").update(canonicalConfigDir).digest("hex"); }
/** No default native binding: the controller explicitly provides an OS-protected store. */
export function openPickerCaCredential(configId: string, store: PickerCaStore): PickerCaCredential {
  if (!/^[a-f0-9]{64}$/.test(configId)) throw new Error("picker_ca_store_invalid");
  try { return store(PICKER_CA_STORE_SERVICE, configId); } catch { throw new Error("picker_ca_store_unavailable"); }
}
export function readPickerCaCredential(entry: PickerCaCredential): string | null {
  try { const raw = entry.getPassword(); if (raw !== null && (typeof raw !== "string" || Buffer.byteLength(raw) > PICKER_CA_MAX_PAYLOAD_BYTES)) throw new Error(); return raw; }
  catch { throw new Error("picker_ca_store_unavailable"); }
}
export function decodePickerCaCredential(raw: string, configId: string, acceptsAuthority: (pem: string) => boolean, now = Date.now()): StoredPickerCa {
  try {
    if (Buffer.byteLength(raw) > PICKER_CA_MAX_PAYLOAD_BYTES) throw new Error();
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "certPem,configId,fingerprint,keyPem,schema"
      || value.schema !== 1 || value.configId !== configId || typeof value.certPem !== "string" || typeof value.keyPem !== "string"
      || typeof value.fingerprint !== "string" || !/^[A-F0-9]{64}$/.test(value.fingerprint)) throw new Error();
    const cert = new X509Certificate(value.certPem), privateKey = createPrivateKey(value.keyPem), publicKey = createPublicKey(value.keyPem);
    if (!Number.isFinite(now) || !acceptsAuthority(value.certPem) || cert.toString() !== value.certPem || !cert.ca || !cert.checkPrivateKey(privateKey) || !cert.verify(publicKey)
      || privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      || privateKey.export({ type: "pkcs8", format: "pem" }) !== value.keyPem || !(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo))
      || createHash("sha256").update(cert.raw).digest("hex").toUpperCase() !== value.fingerprint) throw new Error();
    return { certPem: value.certPem, keyPem: value.keyPem, fingerprint: value.fingerprint, privateKey, publicKey };
  } catch { throw new Error("picker_ca_store_invalid"); }
}
export function writePickerCaCredential(entry: PickerCaCredential, configId: string, ca: StoredPickerCa, acceptsAuthority: (pem: string) => boolean, now = Date.now()): void {
  const raw = JSON.stringify({ schema: 1, configId, fingerprint: ca.fingerprint, certPem: ca.certPem, keyPem: ca.keyPem });
  decodePickerCaCredential(raw, configId, acceptsAuthority, now);
  try { entry.setPassword(raw); } catch { throw new Error("picker_ca_store_unavailable"); }
  if (readPickerCaCredential(entry) !== raw) throw new Error("picker_ca_store_readback_failed");
}
/** Notch/native adapter must implement user-scoped DPAPI on Windows or login Keychain on macOS.
 * Plaintext is never persisted by this module; native failures never include key material. */
export interface PickerProtectedStoreOperation {
  read(service: string, account: string): Promise<string | null>;
  write(service: string, account: string, value: string): Promise<void>;
}
export async function readProtectedPickerCa(configId: string, native: PickerProtectedStoreOperation): Promise<string | null> {
  try {
    if (!/^[a-f0-9]{64}$/.test(configId)) throw new Error();
    const raw = await native.read(PICKER_CA_STORE_SERVICE, configId);
    if (raw !== null && (typeof raw !== "string" || Buffer.byteLength(raw) > PICKER_CA_MAX_PAYLOAD_BYTES)) throw new Error();
    return raw;
  } catch { throw new Error("picker_ca_store_unavailable"); }
}
export async function writeProtectedPickerCa(configId: string, ca: StoredPickerCa, acceptsAuthority: (pem: string) => boolean, native: PickerProtectedStoreOperation, now = Date.now()): Promise<void> {
  const raw = JSON.stringify({ schema: 1, configId, fingerprint: ca.fingerprint, certPem: ca.certPem, keyPem: ca.keyPem });
  decodePickerCaCredential(raw, configId, acceptsAuthority, now);
  try { await native.write(PICKER_CA_STORE_SERVICE, configId, raw); } catch { throw new Error("picker_ca_store_unavailable"); }
  if (await readProtectedPickerCa(configId, native) !== raw) throw new Error("picker_ca_store_readback_failed");
}
