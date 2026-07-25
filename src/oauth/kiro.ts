/**
 * Kiro (AWS CodeWhisperer) OAuth — import-first.
 *
 * Normal login imports the locally installed kiro-cli session. Account-add login deliberately
 * asks kiro-cli to switch identities in its supported browser flow, then imports that fresh session.
 *
 * Ported from jawcode packages/ai/src/providers/kiro.ts (readKiroCliSqlite, refreshKiroDesktopToken).
 * profileArn/region/client registration are persisted per OCX account so switching the account pool
 * never combines one account's access token with another account's local Kiro profile metadata.
 */
import type { KiroOAuthMetadata, OAuthController, OAuthCredentials } from "./types";
import {
  inferRegionFromProfileArn,
  inspectKiroCliSqliteSources,
  normalizeKiroRegion,
  readImportedKiroCredential,
  readKiroCliSqliteCredential,
  requireKiroRegion,
  type ImportedKiroCredential,
  type KiroImportDiagnostic,
} from "./kiro-credentials";

const DEFAULT_REGION = "us-east-1";
const REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
const OIDC_URL = "https://oidc.{region}.amazonaws.com/token";
const KIRO_TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "refresh_token_reused",
  "revoked",
  "revoked_token",
  "refresh_token_revoked",
  "access_denied",
  "expired_token",
]);

interface ImportedKiroToken {
  access: string;
  refresh: string;
  expires: number;
}

export interface KiroCliCommandResult {
  exitCode: number;
  stdout: string;
}

export class KiroTokenRefreshError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly oauthError?: string,
  ) {
    super(`Kiro token refresh failed: ${httpStatus}${oauthError ? ` (${oauthError})` : ""}`);
    this.name = "KiroTokenRefreshError";
  }
}

export type KiroCliRunner = (args: string[], signal?: AbortSignal) => Promise<KiroCliCommandResult>;

export interface KiroLoginOptions {
  forceLogin?: boolean;
  cliRunner?: KiroCliRunner;
}

function throwIfKiroLoginCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Kiro login cancelled.");
}

async function defaultKiroCliRunner(args: string[], signal?: AbortSignal): Promise<KiroCliCommandResult> {
  throwIfKiroLoginCancelled(signal);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["kiro-cli", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
  } catch {
    throw new Error("Kiro CLI is not installed or could not be started.");
  }
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve(""),
    ]);
    throwIfKiroLoginCancelled(signal);
    return { exitCode, stdout };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function readKiroCliIdentity(runner: KiroCliRunner, signal?: AbortSignal): Promise<{ email?: string }> {
  try {
    const result = await runner(["whoami", "--format", "json"], signal);
    if (result.exitCode !== 0) return {};
    const parsed = JSON.parse(result.stdout) as { email?: unknown };
    const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
    return email && email.length <= 320 ? { email } : {};
  } catch {
    return {};
  }
}

function metadataFromImported(imported: ImportedKiroCredential): KiroOAuthMetadata | undefined {
  const metadata: KiroOAuthMetadata = {
    ...(imported.profileArn ? { profileArn: imported.profileArn } : {}),
    ...(imported.ssoRegion ? { ssoRegion: imported.ssoRegion } : {}),
    ...(imported.apiRegion ? { apiRegion: imported.apiRegion } : {}),
    ...(imported.clientId ? { clientId: imported.clientId } : {}),
    ...(imported.clientSecret ? { clientSecret: imported.clientSecret } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function oauthCredentialFromImported(
  imported: ImportedKiroCredential,
  runner: KiroCliRunner,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const identity = imported.source === "sqlite" ? await readKiroCliIdentity(runner, signal) : {};
  const metadata = metadataFromImported(imported);
  return {
    access: imported.access,
    refresh: imported.refresh,
    expires: imported.expires,
    source: imported.source === "json" ? "credential-file" : "local-cli",
    ...(imported.profileArn ? { accountId: imported.profileArn } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(metadata ? { kiro: metadata } : {}),
  };
}

export type KiroCliImportDiagnosticStatus = KiroImportDiagnostic["status"];
export type KiroCliImportDiagnostic = KiroImportDiagnostic;

export function inspectKiroCliSqlite(): { token: ImportedKiroToken | null; diagnostics: KiroCliImportDiagnostic[] } {
  const { credential, diagnostics } = inspectKiroCliSqliteSources();
  return {
    token: credential ? { access: credential.access, refresh: credential.refresh, expires: credential.expires } : null,
    diagnostics,
  };
}

/** Read the kiro-cli SQLite token store (mac/linux). Returns null if no token found. */
export function readKiroCliSqlite(): ImportedKiroToken | null {
  const imported = readKiroCliSqliteCredential();
  return imported ? { access: imported.access, refresh: imported.refresh, expires: imported.expires } : null;
}

/**
 * Import-first login: kiro-cli SQLite → KIRO_ACCESS_TOKEN env → manual paste (CLI only).
 * When no local token is available, resolves the login flow via onAuth with instructions
 * so the GUI renders the paste-input field, then blocks on onManualCodeInput for the token.
 * If neither onAuth nor onManualCodeInput is available, throws a clear error.
 */
export async function loginKiro(ctrl: OAuthController, options: KiroLoginOptions = {}): Promise<OAuthCredentials> {
  const runner = options.cliRunner ?? defaultKiroCliRunner;
  if (options.forceLogin) {
    throwIfKiroLoginCancelled(ctrl.signal);
    ctrl.onAuth?.({
      url: "",
      instructions: "Kiro CLI is opening a fresh browser login. This also switches the account used by kiro-cli.",
    });
    ctrl.onProgress?.("Opening a fresh Kiro CLI browser login.");
    const logout = await runner(["logout"], ctrl.signal);
    throwIfKiroLoginCancelled(ctrl.signal);
    if (logout.exitCode !== 0) throw new Error("Kiro CLI could not prepare a fresh login.");
    const login = await runner(["login"], ctrl.signal);
    throwIfKiroLoginCancelled(ctrl.signal);
    if (login.exitCode !== 0) throw new Error("Kiro CLI login did not complete successfully.");
    const fresh = readKiroCliSqliteCredential();
    if (!fresh) throw new Error("Kiro CLI login completed but no credential could be imported.");
    const credential = await oauthCredentialFromImported(fresh, runner, ctrl.signal);
    throwIfKiroLoginCancelled(ctrl.signal);
    if (!credential.accountId && !credential.email) {
      throw new Error("Kiro login completed but OCX could not determine a stable account identity.");
    }
    return credential;
  }

  const imported = readImportedKiroCredential();
  if (imported) {
    ctrl.onProgress?.(imported.source === "json" ? "Imported token from Kiro credentials file." : "Imported token from installed kiro-cli login.");
    return oauthCredentialFromImported(imported, runner, ctrl.signal);
  }

  const envToken = process.env.KIRO_ACCESS_TOKEN;
  if (envToken) {
    ctrl.onProgress?.("Using KIRO_ACCESS_TOKEN from environment.");
    return { access: envToken, refresh: process.env.KIRO_REFRESH_TOKEN ?? "", expires: Date.now() + 3600_000, source: "environment" };
  }

  if (ctrl.onManualCodeInput) {
    // Resolve the login flow immediately so the GUI receives instructions and
    // shows the paste-input field. Without this, onManualCodeInput blocks
    // forever and the HTTP response never reaches the dashboard.
    ctrl.onAuth?.({
      url: "",
      instructions:
        "No kiro-cli token found. Paste a Kiro access token below (starts with 'aoa'). " +
        "Run `kiro-cli login` first, or set KIRO_ACCESS_TOKEN.",
    });
    ctrl.onProgress?.("No kiro-cli token found. Paste a Kiro access token (starts with 'aoa').");
    const raw = (await ctrl.onManualCodeInput()).trim();
    if (raw) return { access: raw, refresh: "", expires: Date.now() + 3600_000, source: "manual" };
  }

  throw new Error(
    "Kiro: no token found. Run `kiro-cli login` first (import), or set KIRO_ACCESS_TOKEN. " +
      "Browser login is not supported for Kiro.",
  );
}

/** Account metadata is authoritative; legacy accountless calls use KIRO_REGION → local import → default. */
export function resolveKiroRegion(account?: KiroOAuthMetadata): string {
  if (account !== undefined) return normalizeKiroRegion(account.ssoRegion) || DEFAULT_REGION;
  if (process.env.KIRO_REGION !== undefined) return requireKiroRegion(process.env.KIRO_REGION);
  return normalizeKiroRegion(readImportedKiroCredential()?.ssoRegion) || DEFAULT_REGION;
}

/** Account metadata is authoritative; legacy accountless calls may use KIRO_API_REGION/local import. */
export function resolveKiroApiRegion(account?: Pick<KiroOAuthMetadata, "apiRegion" | "profileArn" | "ssoRegion">): string {
  if (account !== undefined) {
    return (
      normalizeKiroRegion(account.apiRegion) ||
      inferRegionFromProfileArn(account.profileArn) ||
      normalizeKiroRegion(account.ssoRegion) ||
      DEFAULT_REGION
    );
  }
  if (process.env.KIRO_API_REGION !== undefined) return requireKiroRegion(process.env.KIRO_API_REGION);
  const imported = readImportedKiroCredential();
  return (
    normalizeKiroRegion(imported?.apiRegion) ||
    inferRegionFromProfileArn(imported?.profileArn) ||
    normalizeKiroRegion(imported?.ssoRegion) ||
    (process.env.KIRO_REGION !== undefined ? requireKiroRegion(process.env.KIRO_REGION) : undefined) ||
    DEFAULT_REGION
  );
}

/**
 * Resolve the CodeWhisperer profileArn for request-time use by the adapter.
 * Account metadata is authoritative. Legacy accountless calls use KIRO_PROFILE_ARN → local import.
 * Returns undefined if absent (the adapter decides whether that is fatal).
 */
export function resolveKiroProfileArn(account?: Pick<KiroOAuthMetadata, "profileArn">): string | undefined {
  if (account !== undefined) return account.profileArn;
  const env = process.env.KIRO_PROFILE_ARN;
  if (env) return env;
  return readImportedKiroCredential()?.profileArn;
}

async function kiroTokenRefreshError(response: Response): Promise<KiroTokenRefreshError> {
  let oauthError: string | undefined;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string" && KIRO_TERMINAL_REFRESH_ERRORS.has(payload.error)) {
      oauthError = payload.error;
    }
  } catch {
    // Error bodies are untrusted and intentionally excluded from the surfaced message.
  }
  return new KiroTokenRefreshError(response.status, oauthError);
}

async function readTokenResponse(res: Response, oldRefresh: string): Promise<OAuthCredentials> {
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!data.accessToken) throw new Error("Kiro refresh returned no accessToken");
  return {
    access: data.accessToken,
    refresh: data.refreshToken || oldRefresh,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000,
  };
}

async function refreshKiroDesktopToken(refresh: string, signal?: AbortSignal, metadata?: KiroOAuthMetadata): Promise<OAuthCredentials> {
  const region = resolveKiroRegion(metadata);
  const res = await fetch(REFRESH_URL.replace("{region}", region), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw await kiroTokenRefreshError(res);
  return readTokenResponse(res, refresh);
}

async function refreshAwsSsoOidcToken(
  refresh: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  let metadata = credential?.kiro;
  if (!metadata) {
    const local = readImportedKiroCredential();
    if (local?.refresh === refresh) metadata = metadataFromImported(local);
  }
  const clientId = metadata?.clientId;
  const clientSecret = metadata?.clientSecret;
  if (!clientId || !clientSecret) return refreshKiroDesktopToken(refresh, signal, metadata);
  const region = resolveKiroRegion(metadata);
  const run = async (refreshToken: string): Promise<Response> => fetch(OIDC_URL.replace("{region}", region), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "refresh_token",
      clientId,
      clientSecret,
      refreshToken,
    }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const res = await run(refresh);
  if (!res.ok) throw await kiroTokenRefreshError(res);
  return readTokenResponse(res, refresh);
}

export async function refreshKiroToken(
  refresh: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!refresh) throw new Error("Kiro: no refresh token available (re-run `kiro-cli login`).");
  return refreshAwsSsoOidcToken(refresh, signal, credential);
}
