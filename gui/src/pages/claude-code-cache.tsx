import { useCallback } from "react";
import { useT, useI18n } from "../i18n/shared";
import { useDataSurface } from "../data-surface";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";

interface CacheRow {
  provider: string; model: string; requestedRetention?: "none" | "short" | "long";
  lastObservedAt: number; readTokens: number | null; writeTokens: number | null;
  status: "hit" | "miss" | "unreported"; hitRatio: number | null; stale: boolean; httpStatus: number;
}
interface CacheState { generatedAt: number; rows: CacheRow[] }

export function ClaudeCodeCache({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const fetchCache = useCallback(async (signal: AbortSignal) => {
    const response = await fetch(`${apiBase}/api/claude-code/cache`, { signal });
    const data = await readJsonOrThrow<CacheState>(response, t("claude.loadFail"));
    if (!data) throw new Error(t("claude.loadFail"));
    return data;
  }, [apiBase, t]);
  const resource = useDataSurface<CacheState>(`claude-cache:${apiBase}`, [apiBase], fetchCache,
    { enabled: active, isEmpty: data => data.rows.length === 0, pollMs: 15_000, pauseWhenHidden: true });
  const state = resource.state;
  if (!active) return null;
  return <div aria-busy={state.refreshing}>
    <p>{t("claude.cache.hint")}</p>
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
    {state.showSkeleton && <p>{t("claude.loading")}</p>}
    {state.showError && <Notice tone="err">{t("claude.loadFail")}</Notice>}
    {state.data?.rows.length === 0 && <p>{t("claude.cache.empty")}</p>}
    {state.data?.rows.map(row => <article className="card" key={`${row.provider}/${row.model}`}>
      <h4><code>{row.provider}/{row.model}</code></h4>
      <p>{t(`claude.cache.${row.status}`)}{row.hitRatio !== null ? ` · ${(row.hitRatio * 100).toFixed(1)}%` : ""}
        {row.stale ? ` · ${t("claude.cache.stale")}` : ""} · <code>{row.httpStatus}</code></p>
      <dl>
        <dt>{t("claude.cache.read")}</dt><dd>{row.readTokens ?? "—"} / {row.writeTokens ?? "—"}</dd>
        <dt>{t("claude.cache.retention")}</dt><dd>{row.requestedRetention === "long" ? <code>1h</code>
          : row.requestedRetention === "short" ? <code>5m</code> : row.requestedRetention === "none" ? <code>0</code> : t("claude.cache.unknown")}</dd>
        <dt>{t("claude.cache.observed")}</dt><dd>{new Date(row.lastObservedAt).toLocaleString(locale)}</dd>
      </dl>
    </article>)}
  </div>;
}
