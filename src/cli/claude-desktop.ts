import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, saveConfigPreservingClaudeCode } from "../config";
import {
  DESKTOP_FAMILIES,
  moveDesktopRoute,
  parseDesktopProfile,
  setDesktopFamilyDefault,
  type DesktopFamily,
  type DesktopProfile,
} from "../claude/desktop-profile";
import { writeDesktop3pConfig, type Desktop3pConfigMode } from "../claude/desktop-3p";
import { filterCatalogVisibleModels, desktopVisibleNativeSlugs } from "../codex/catalog";
import { buildClaudeDesktopState, fetchAllModels } from "../server/management-api";
import { findLiveProxy } from "../server/proxy-liveness";
import { runtimeRequest } from "./runtime-api";
import { isDesktopApplyInvocation, parseDesktopApplyTarget } from "../claude/desktop-apply-flags";

function isFamily(value: string | undefined): value is DesktopFamily {
  return !!value && (DESKTOP_FAMILIES as readonly string[]).includes(value);
}

function printDesktopHelp(): void {
  console.log(`Usage:
  ocx claude desktop [apply] [--first-party | --gateway [--static|--hybrid|--discovery-only]]
  ocx claude desktop show [--json]
  ocx claude desktop move <provider/model> <opus|fable|sonnet|haiku> [--default]
  ocx claude desktop default <family> <provider/model|none>
  ocx claude desktop export <path|->
  ocx claude desktop import <path> [--apply]`);
}

export interface ApplyProfileDeps {
  findLiveProxyImpl?: typeof findLiveProxy;
  postApplyImpl?: (
    mode: Desktop3pConfigMode,
    profile: DesktopProfile,
  ) => Promise<{ ok?: boolean; path?: string; error?: string }>;
}

export async function applyProfile(
  profile: DesktopProfile,
  mode: Desktop3pConfigMode,
  deps: ApplyProfileDeps = {},
): Promise<{ ok: boolean; path: string; reason?: string }> {
  const config = loadConfig();
  const state = await buildClaudeDesktopState(config, profile);
  config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: state.profile };
  saveConfigPreservingClaudeCode(config);
  const live = await (deps.findLiveProxyImpl ?? findLiveProxy)();
  if (live) {
    // #859: the Desktop alias reverse-map is process-local. Applying through the
    // serving process installs the map there; a local-only write leaves the
    // daemon unable to decode aliases, and the provider rejects them (400).
    const post = deps.postApplyImpl ?? (async (m: Desktop3pConfigMode, p: DesktopProfile) =>
      runtimeRequest<{ ok?: boolean; path?: string; error?: string }>(
        "/api/claude-desktop/apply",
        // The daemon's config may be older than what we just saved, so the
        // profile travels with the request instead of being re-read there.
        { method: "POST", body: JSON.stringify({ mode: m, profile: p }) },
      ));
    try {
      const applied = await post(mode, state.profile);
      if (applied.ok === false) return { ok: false, path: applied.path ?? "", reason: applied.error ?? "daemon apply failed" };
      return { ok: true, path: applied.path ?? "" };
    } catch (error) {
      return { ok: false, path: "", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const allModels = await fetchAllModels(config);
  const routed = filterCatalogVisibleModels(allModels, config).map(model => ({
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
  }));
  const result = writeDesktop3pConfig(
    config.port ?? 10100,
    [...desktopVisibleNativeSlugs(config)],
    routed,
    config.apiKeys?.[0]?.key,
    mode,
    state.profile,
  );
  if (result.written) {
    config.claudeCode = { ...config.claudeCode, desktopMode: "gateway",
      desktopProfile: { ...state.profile, ...(result.fingerprint ? { appliedFingerprint: result.fingerprint, appliedAt: new Date().toISOString() } : {}) } };
    saveConfigPreservingClaudeCode(config);
    if (config.claudeCode.cliFirstParty !== true) {
      const { getConfigDir } = await import("../config");
      const { claudeConfigDir } = await import("../claude/auth-detect");
      const { claudeInterceptCaCertPath } = await import("../claude/intercept/local-ca");
      const { removeClaudeInterceptSettings } = await import("../claude/intercept/settings");
      const removed = removeClaudeInterceptSettings(claudeInterceptCaCertPath(getConfigDir()), claudeConfigDir(process.env));
      if (!removed.ok) return { ok: true, path: result.path, reason: "first_party_cleanup_pending" };
    }
  }
  return { ok: result.written, path: result.path, reason: result.reason };
}

export async function handleClaudeDesktopCommand(argv: string[], deps: ApplyProfileDeps = {}): Promise<number> {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    printDesktopHelp();
    return 0;
  }

  if (isDesktopApplyInvocation(argv)) {
    const parsed = parseDesktopApplyTarget(argv, loadConfig());
    if ("error" in parsed) { console.error(parsed.error); return 1; }
    if (parsed.target.transport === "first-party") {
      try {
        const live = await (deps.findLiveProxyImpl ?? findLiveProxy)();
        if (!live) { console.error("Start the local OCX server before applying first-party mode."); return 1; }
        const result = await runtimeRequest<{ ok: boolean; reason?: string; rollbackComplete?: boolean }>("/api/claude-desktop/apply", {
          method: "POST", body: JSON.stringify({ transport: "first-party" }),
        });
        if (!result.ok) { console.error(`First-party apply failed: ${result.reason ?? "unavailable"}`); return 1; }
        console.log("Claude Desktop first-party settings applied. Quit and reopen Desktop when ready.");
        return 0;
      } catch { console.error("First-party apply unavailable; existing settings were preserved."); return 1; }
    }
    try {
      const config = loadConfig();
      const state = await buildClaudeDesktopState(config);
      const result = await applyProfile(state.profile, parsed.target.mode, deps);
      if (!result.ok) {
        console.error(`설정 적용 실패: ${result.reason ?? "unknown error"}`);
        console.error("프로필은 저장되었지만 Claude Desktop 설정 파일에는 반영되지 않았습니다. 프록시 상태를 확인한 뒤 다시 적용해 주세요.");
        return 1;
      }
      console.log(`Claude Desktop 설정을 적용했습니다: ${result.path}`);
      console.log("Claude Desktop을 완전히 종료한 뒤 다시 열어 주세요.");
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const config = loadConfig();
    const state = await buildClaudeDesktopState(config);
    if (command === "show") {
      if (argv.length > 2 || (argv[1] && argv[1] !== "--json")) throw new Error("Usage: ocx claude desktop show [--json]");
      if (argv[1] === "--json") console.log(JSON.stringify(state));
      else {
        for (const family of DESKTOP_FAMILIES) {
          console.log(`${family.toUpperCase()}${state.profile.defaults[family] ? ` (default: ${state.profile.defaults[family]})` : ""}`);
          for (const model of state.models.filter(item => item.assignment.family === family)) {
            console.log(`  ${model.available ? "•" : "○"} ${model.route} -> ${model.assignment.alias}${model.available ? "" : " (unavailable)"}`);
          }
        }
      }
      return 0;
    }
    if (command === "move") {
      const [, route, familyRaw, ...flags] = argv;
      if (!route || !isFamily(familyRaw) || flags.some(flag => flag !== "--default")) throw new Error("Usage: ocx claude desktop move <route> <family> [--default]");
      if (!state.models.some(model => model.route === route && model.available)) throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = moveDesktopRoute(state.profile, route, familyRaw, flags.includes("--default"));
      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: profile };
      saveConfigPreservingClaudeCode(config);
      console.log(`${route} 모델을 ${familyRaw} 그룹으로 옮겼습니다.`);
      return 0;
    }
    if (command === "default") {
      const [, familyRaw, routeRaw] = argv;
      if (!isFamily(familyRaw) || !routeRaw || argv.length !== 3) throw new Error("Usage: ocx claude desktop default <family> <route|none>");
      const route = routeRaw === "none" ? null : routeRaw;
      if (route && !state.models.some(model => model.route === route && model.available)) throw new Error(`현재 사용할 수 없는 모델입니다: ${route}`);
      const profile = setDesktopFamilyDefault(state.profile, familyRaw, route);
      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: profile };
      saveConfigPreservingClaudeCode(config);
      console.log(`${familyRaw} 기본 모델을 ${route ?? "없음"}으로 지정했습니다.`);
      return 0;
    }
    if (command === "export") {
      const target = argv[1];
      if (!target || argv.length !== 2) throw new Error("Usage: ocx claude desktop export <path|->");
      const json = JSON.stringify(state.profile, null, 2) + "\n";
      if (target === "-") process.stdout.write(json);
      else writeFileSync(resolve(target), json, { encoding: "utf8", mode: 0o600 });
      return 0;
    }
    if (command === "import") {
      const source = argv[1];
      const flags = argv.slice(2);
      if (!source || flags.some(flag => flag !== "--apply")) throw new Error("Usage: ocx claude desktop import <path> [--apply]");
      const profile = parseDesktopProfile(JSON.parse(readFileSync(resolve(source), "utf8")));
      const reconciled = (await buildClaudeDesktopState(config, profile)).profile;
      config.claudeCode = { ...(config.claudeCode ?? {}), desktopProfile: reconciled };
      saveConfigPreservingClaudeCode(config);
      if (flags.includes("--apply")) {
        const result = await applyProfile(reconciled, "static", deps);
        if (!result.ok) { console.error(`프로필은 저장했지만 Desktop 적용에 실패했습니다: ${result.reason ?? "unknown error"}`); return 1; }
      }
      console.log("Claude Desktop 프로필을 가져왔습니다.");
      return 0;
    }
    printDesktopHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
