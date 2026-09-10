import type { OAuthController, OAuthCredentials } from "./types";
import { requireKiroRegion } from "./kiro-credentials";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
];
const MAX_LOGIN_LIFETIME_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,511}$/;
const USER_CODE = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/i;
const SAFE_OAUTH_ERRORS = new Set([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
]);

interface OrganizationLogin {
  startUrl: string;
  region: string;
}

export interface KiroDeviceLoginDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  maxLifetimeMs?: number;
}

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

type VerificationKind = "regional-device" | "organization-portal";

interface DeviceToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface KiroIdentity {
  userId: string;
  email?: string;
}

function cancelled(signal?: AbortSignal): never {
  if (signal?.aborted) throw new Error("Kiro login cancelled.");
  throw new Error("Kiro login request failed.");
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Kiro login cancelled."));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Kiro login cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function requestSignal(signal: AbortSignal | undefined, remainingMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("Kiro login service returned an invalid response.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Kiro login service returned an invalid response.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Kiro login service returned an invalid response.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(payload);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Kiro login service returned an invalid response.");
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error(`Kiro login service returned no ${label}.`);
  }
  return value;
}

function positiveNumber(value: unknown, fallback?: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error("Kiro login service returned invalid timing information.");
}

function parseVerificationUrl(value: unknown): URL {
  const raw = requiredString(value, "verification URL");
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("Kiro login service returned an unsafe verification URL.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Kiro login service returned an unsafe verification URL.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new Error("Kiro login service returned an unsafe verification URL.");
  }
  return url;
}

function safeVerificationUrl(
  verificationValue: unknown,
  completeValue: unknown,
  organization: OrganizationLogin,
  userCode: string,
): string {
  const verification = parseVerificationUrl(verificationValue);
  const complete = parseVerificationUrl(completeValue);
  const portal = new URL(organization.startUrl);
  const regionalHost = `device.sso.${organization.region}.amazonaws.com`;
  let kind: VerificationKind;

  if (
    verification.hostname.toLowerCase() === regionalHost
    && verification.search === ""
    && verification.hash === ""
  ) {
    kind = "regional-device";
  } else if (
    verification.origin === portal.origin
    && verification.pathname === "/start/"
    && verification.search === ""
    && verification.hash === "#/device"
  ) {
    kind = "organization-portal";
  } else {
    throw new Error("Kiro login service returned an unsafe verification URL.");
  }

  let parameters: URLSearchParams;
  if (kind === "regional-device") {
    if (
      complete.hostname.toLowerCase() !== regionalHost
      || complete.pathname !== verification.pathname
      || complete.hash !== ""
    ) {
      throw new Error("Kiro login service returned an unsafe verification URL.");
    }
    parameters = complete.searchParams;
  } else {
    const fragment = complete.hash.slice(1);
    const separator = fragment.indexOf("?");
    if (
      complete.origin !== portal.origin
      || complete.pathname !== "/start/"
      || complete.search !== ""
      || separator < 0
      || fragment.slice(0, separator) !== "/device"
    ) {
      throw new Error("Kiro login service returned an unsafe verification URL.");
    }
    parameters = new URLSearchParams(fragment.slice(separator + 1));
  }

  const entries = [...parameters.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "user_code" || entries[0]?.[1] !== userCode) {
    throw new Error("Kiro login service returned an unsafe verification URL.");
  }
  return complete.toString();
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  remainingMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: requestSignal(signal, remainingMs),
    });
  } catch {
    cancelled(signal);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Kiro login service returned an unexpected redirect.");
  }
  return response;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
    });
  } catch {
    cancelled(signal);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Kiro login service returned an unexpected redirect.");
  }
  return response;
}

async function registerClient(
  fetchImpl: typeof fetch,
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<RegisteredClient> {
  const response = await postJson(fetchImpl, `${baseUrl}/client/register`, {
    clientName: "OpenCodex",
    clientType: "public",
    grantTypes: [DEVICE_GRANT, "refresh_token"],
    scopes: SCOPES,
  }, signal, REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new Error(`Kiro client registration failed (${response.status}).`);
  const data = await readJson(response);
  return {
    clientId: requiredString(data.clientId, "client registration ID"),
    clientSecret: requiredString(data.clientSecret, "client registration secret"),
  };
}

async function startAuthorization(
  fetchImpl: typeof fetch,
  baseUrl: string,
  registration: RegisteredClient,
  organization: OrganizationLogin,
  signal: AbortSignal | undefined,
): Promise<DeviceAuthorization> {
  const response = await postJson(fetchImpl, `${baseUrl}/device_authorization`, {
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
    startUrl: organization.startUrl,
  }, signal, REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new Error(`Kiro device authorization failed (${response.status}).`);
  const data = await readJson(response);
  const userCode = requiredString(data.userCode, "user authorization code");
  if (!USER_CODE.test(userCode)) {
    throw new Error("Kiro login service returned an invalid user authorization code.");
  }
  const verificationUri = safeVerificationUrl(
    data.verificationUri,
    data.verificationUriComplete,
    organization,
    userCode,
  );
  return {
    deviceCode: requiredString(data.deviceCode, "device authorization code"),
    userCode,
    verificationUri,
    expiresIn: positiveNumber(data.expiresIn),
    interval: positiveNumber(data.interval, 5),
  };
}

async function pollToken(
  fetchImpl: typeof fetch,
  baseUrl: string,
  registration: RegisteredClient,
  authorization: DeviceAuthorization,
  signal: AbortSignal | undefined,
  now: () => number,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  maxLifetimeMs: number,
): Promise<DeviceToken> {
  const deadline = now() + Math.min(authorization.expiresIn * 1000, maxLifetimeMs);
  let intervalMs = Math.max(1_000, authorization.interval * 1000);
  while (true) {
    if (signal?.aborted) cancelled(signal);
    const beforeSleep = deadline - now();
    if (beforeSleep <= 0 || intervalMs > beforeSleep) throw new Error("Kiro device authorization expired.");
    await sleep(intervalMs, signal);
    if (signal?.aborted) cancelled(signal);
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Kiro device authorization expired.");
    const response = await postJson(fetchImpl, `${baseUrl}/token`, {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      deviceCode: authorization.deviceCode,
      grantType: DEVICE_GRANT,
    }, signal, remaining);
    const data = await readJson(response);
    if (response.ok) {
      return {
        accessToken: requiredString(data.accessToken, "access token"),
        refreshToken: requiredString(data.refreshToken, "refresh token"),
        expiresIn: positiveNumber(data.expiresIn, 3600),
      };
    }
    const code = typeof data.error === "string" && SAFE_OAUTH_ERRORS.has(data.error)
      ? data.error
      : undefined;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (code === "access_denied") throw new Error("Kiro device authorization was denied.");
    if (code === "expired_token") throw new Error("Kiro device authorization expired.");
    throw new Error(`Kiro token request failed (${response.status}).`);
  }
}

async function usageIdentity(
  fetchImpl: typeof fetch,
  region: string,
  accessToken: string,
  signal: AbortSignal | undefined,
): Promise<KiroIdentity | undefined> {
  const url = new URL(`https://q.${region}.amazonaws.com/getUsageLimits`);
  url.searchParams.set("origin", "KIRO_CLI");
  url.searchParams.set("resourceType", "AGENTIC_REQUEST");
  url.searchParams.set("isEmailRequired", "true");
  const response = await getJson(fetchImpl, url.toString(), signal, {
    Authorization: `Bearer ${accessToken}`,
  });
  if (!response.ok) return undefined;
  const data = await readJson(response);
  const userInfo = data.userInfo;
  if (!userInfo || typeof userInfo !== "object" || Array.isArray(userInfo)) return undefined;
  const userId = (userInfo as Record<string, unknown>).userId;
  if (typeof userId !== "string" || !USER_ID.test(userId)) return undefined;
  const rawEmail = (userInfo as Record<string, unknown>).email;
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  return {
    userId,
    ...(email.length > 0 && email.length <= 320 ? { email } : {}),
  };
}

async function resolveIdentity(
  fetchImpl: typeof fetch,
  region: string,
  accessToken: string,
  signal: AbortSignal | undefined,
): Promise<KiroIdentity> {
  const identity = await usageIdentity(fetchImpl, region, accessToken, signal);
  if (!identity) {
    throw new Error("Kiro login completed but OCX could not determine a stable account identity.");
  }
  return identity;
}

export async function resolveKiroOrganizationProfile(accessToken: string, region: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string> {
  const safeRegion = requireKiroRegion(region);
  const response = await postJson(fetchImpl, `https://q.${safeRegion}.amazonaws.com/ListAvailableProfiles`, {}, signal, REQUEST_TIMEOUT_MS, { Authorization: `Bearer ${accessToken}` });
  if (!response.ok) throw new Error(`Kiro organization profile lookup failed (${response.status}).`);
  const data = await readJson(response);
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const arns = profiles.map(p => p && typeof p === 'object' ? (p as Record<string, unknown>).arn : undefined)
    .filter((arn): arn is string => typeof arn === 'string' && /^arn:[a-z0-9-]+:codewhisperer:[a-z0-9-]+:\d{12}:profile\/[A-Za-z0-9-]+$/.test(arn));
  if (arns.length !== 1 || data.nextToken) throw new Error('Kiro organization login requires one unambiguous organization profile.');
  return arns[0]!;
}

export async function loginKiroOrganizationDevice(
  ctrl: OAuthController,
  organization: OrganizationLogin,
  dependencies: KiroDeviceLoginDependencies = {},
): Promise<OAuthCredentials> {
  const region = requireKiroRegion(organization.region);
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const maxLifetimeMs = Math.min(
    MAX_LOGIN_LIFETIME_MS,
    Math.max(1_000, dependencies.maxLifetimeMs ?? MAX_LOGIN_LIFETIME_MS),
  );
  const baseUrl = `https://oidc.${region}.amazonaws.com`;
  if (ctrl.signal?.aborted) cancelled(ctrl.signal);
  ctrl.onProgress?.("Registering Kiro IAM Identity Center device login.");
  const registration = await registerClient(fetchImpl, baseUrl, ctrl.signal);
  const authorization = await startAuthorization(fetchImpl, baseUrl, registration, organization, ctrl.signal);
  ctrl.onAuth?.({
    url: authorization.verificationUri,
    deviceCode: authorization.userCode,
    instructions: "Open the AWS verification page and confirm the displayed code.",
  });
  ctrl.onProgress?.("Waiting for Kiro IAM Identity Center authorization.");
  const token = await pollToken(
    fetchImpl,
    baseUrl,
    registration,
    authorization,
    ctrl.signal,
    now,
    sleep,
    maxLifetimeMs,
  );
  ctrl.onProgress?.("Resolving the authenticated Kiro account.");
  const identity = await resolveIdentity(fetchImpl, region, token.accessToken, ctrl.signal);
  const profileArn = await resolveKiroOrganizationProfile(token.accessToken, region, ctrl.signal, fetchImpl);
  return {
    access: token.accessToken,
    refresh: token.refreshToken,
    expires: now() + token.expiresIn * 1000,
    source: "oauth",
    accountId: identity.userId,
    ...(identity.email ? { email: identity.email } : {}),
    kiro: {
      authType: "aws_sso_oidc",
      ssoRegion: region,
      apiRegion: region,
      profileArn,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
    },
  };
}
