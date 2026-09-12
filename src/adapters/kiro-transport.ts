import { debugProviderDiagnostic } from "../lib/debug";
import { resolveKiroApiRegion, resolveKiroRequestProfile } from "../oauth/kiro";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import type { AdapterFetchContext, AdapterRequest } from "./base";
import { calibrateKiroEstimate } from "./kiro-calibration";
import {
  buildKiroPayload,
  estimateKiroInputTokens,
  estimateKiroLogInputTokens,
  estimateKiroPayloadInputTokens,
  kiroPayloadMessages,
  type KiroWireClient,
} from "./kiro-codec";
import type { KiroCompletionMode } from "./kiro-constants";
import { normalizeKiroImages } from "./kiro-images";
import { fetchKiroWithRetry, noteKiroTransientThrottle } from "./kiro-retry";
import { fingerprint, invocationId, osTag } from "./kiro-wire";

const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
const SDK_VERSION = "1.0.27";
const NODE_VERSION = "22.21.1";
const KIRO_IDE_VERSION = "1.0.0";

export interface KiroNativeBuildResult {
  request: AdapterRequest;
  nameMap: Map<string, string>;
  conversationId: string;
  completionMode: KiroCompletionMode;
  inputTokens: number;
  contextInputEstimate: number;
}

function kiroCliPlatform(): "linux" | "macos" | "windows" {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

function kiroCliUserAgent(includeAppVersion: boolean): string {
  return [
    "aws-sdk-rust/1.3.15",
    "ua/2.1",
    "api/codewhispererstreaming/0.1.17975",
    `os/${kiroCliPlatform()}`,
    "lang/rust/1.92.0",
    ...(includeAppVersion ? ["md/appVersion-2.14.2"] : []),
    "m/F",
    "app/AmazonQ-For-CLI",
  ].join(" ");
}

function kiroRuntimeEndpoint(provider: OcxProviderConfig, region: string): string {
  const configured = new URL(provider.baseUrl);
  if (
    /^runtime\.[a-z]{2}(?:-[a-z]+)+-\d\.kiro\.dev$/i.test(configured.hostname)
    && configured.pathname === "/"
  ) {
    return `https://runtime.${region}.kiro.dev/`;
  }
  return configured.toString();
}

function kiroNativeHeaders(
  provider: OcxProviderConfig,
  wireClient: KiroWireClient,
  isApiKey: boolean,
  profileArn: string | undefined,
): Record<string, string> {
  const fp = fingerprint().slice(0, 64);
  const headers: Record<string, string> = wireClient === "cli" ? {
    authorization: `Bearer ${provider.apiKey}`,
    "content-type": "application/x-amz-json-1.0",
    accept: "*/*",
    "x-amz-target": AMZ_TARGET,
    "user-agent": kiroCliUserAgent(true),
    "x-amz-user-agent": kiroCliUserAgent(false),
    "x-amzn-codewhisperer-optout": "true",
    "amz-sdk-request": "attempt=1; max=3",
    "amz-sdk-invocation-id": invocationId(),
    ...(isApiKey ? { tokentype: "API_KEY" } : {}),
  } : {
    authorization: `Bearer ${provider.apiKey}`,
    "content-type": "application/x-amz-json-1.0",
    accept: "application/vnd.amazon.eventstream",
    "x-amz-target": AMZ_TARGET,
    "user-agent": `aws-sdk-js/${SDK_VERSION} ua/2.1 os/${osTag()} lang/js md/nodejs#${NODE_VERSION} api/codewhispererstreaming#${SDK_VERSION} m/E KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
    "x-amz-user-agent": `aws-sdk-js/${SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}-${fp}`,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "amz-sdk-invocation-id": invocationId(),
  };
  if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
  return headers;
}

/** Build one native CodeWhisperer GenerateAssistantResponse request from canonical OCX state. */
export async function buildKiroNativeRequest(
  provider: OcxProviderConfig,
  parsed: OcxParsedRequest,
  forcedCompletionMode?: KiroCompletionMode,
): Promise<KiroNativeBuildResult> {
  if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
    throw new Error("kiro token missing — run ocx login kiro");
  }

  const region = resolveKiroApiRegion(parsed._kiroAuthContext);
  const requestProfile = resolveKiroRequestProfile(parsed._kiroAuthContext);
  const isApiKey = provider.apiKey.trim().startsWith("ksk_");
  const profileArn = isApiKey ? undefined : requestProfile.profileArn;
  const wireClient: KiroWireClient = isApiKey || requestProfile.builderIdFallback || !profileArn ? "cli" : "ide";
  const headers = kiroNativeHeaders(provider, wireClient, isApiKey, profileArn);

  const built = buildKiroPayload(parsed, profileArn, forcedCompletionMode, wireClient);
  await normalizeKiroImages(built.payload);
  const rawContextInputEstimate = estimateKiroPayloadInputTokens(built.payload, parsed.modelId);
  const contextInputEstimate = calibrateKiroEstimate(built.conversationId, rawContextInputEstimate);
  const body = JSON.stringify(built.payload);

  debugProviderDiagnostic("kiro", "request", {
    region,
    requestedModel: parsed.modelId,
    completionMode: built.completionMode,
    bodyBytes: new TextEncoder().encode(body).length,
    messageCount: kiroPayloadMessages(parsed).length,
    toolCount: parsed.context.tools?.length ?? 0,
    hasProfileArn: Boolean(profileArn),
    wireClient,
    hasPreviousResponseId: Boolean(parsed.previousResponseId),
  });

  return {
    request: {
      url: kiroRuntimeEndpoint(provider, region),
      method: "POST",
      headers,
      body,
      usageLog: { inputTokens: estimateKiroLogInputTokens(parsed), estimated: true },
    },
    nameMap: built.nameMap,
    conversationId: built.conversationId,
    completionMode: built.completionMode,
    inputTokens: estimateKiroInputTokens(parsed),
    contextInputEstimate,
  };
}

/** Stream-level throttles arrive after HTTP 200; record them at the native transport boundary. */
export function noteKiroNativeTransientThrottle(): void {
  noteKiroTransientThrottle();
}

/** Native fetch boundary, including the existing Kiro retry/cooldown rules. */
export function fetchKiroNativeResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
  return fetchKiroWithRetry(request, ctx);
}
