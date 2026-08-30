use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub pid: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDetails {
    pub heap_used: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub name: String,
    pub auth_mode: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub label: String,
    pub percent: Option<f64>,
    pub reset_at: Option<f64>,
    #[serde(default)]
    pub value_label: Option<String>,
    #[serde(default)]
    pub segments: Vec<QuotaSegment>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSegment {
    pub label: String,
    pub percent: Option<f64>,
    pub reset_at: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub five_hour_percent: Option<f64>,
    pub five_hour_reset_at: Option<f64>,
    pub weekly_percent: Option<f64>,
    pub weekly_reset_at: Option<f64>,
    pub monthly_percent: Option<f64>,
    pub monthly_reset_at: Option<f64>,
    pub reset_credits: Option<u32>,
    #[serde(default)]
    pub custom_windows: Vec<QuotaWindow>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaReport {
    pub provider: String,
    pub label: Option<String>,
    #[serde(default)]
    pub quota: Quota,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaResponse {
    #[serde(default)]
    pub reports: Vec<QuotaReport>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProvider {
    pub provider: String,
    #[serde(default)]
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct UsageResponse {
    #[serde(default)]
    pub days: Vec<UsageDay>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct UsageDay {
    pub date: String,
    #[serde(default)]
    pub models: Vec<UsageDayModel>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDayModel {
    pub provider: String,
    #[serde(default)]
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RequestLogEntry {
    pub timestamp: u64,
    pub model: String,
    pub provider: String,
    pub resolved_model: Option<String>,
    pub status: u16,
    pub duration_ms: u64,
    pub display_metrics: Option<LogDisplayMetrics>,
    pub total_tokens: Option<u64>,
    pub usage_status: Option<String>,
    pub error_code: Option<String>,
    pub requested_effort: Option<String>,
    pub requested_speed_label: Option<String>,
    pub configured_speed_label: Option<String>,
    pub requested_service_tier: Option<String>,
    pub configured_service_tier: Option<String>,
    pub response_service_tier: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LogDisplayMetrics {
    pub tok_per_second: Option<TokPerSecondMetric>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TokPerSecondMetric {
    pub kind: String,
    pub value: Option<f64>,
    pub estimated: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum RequestLogsResponse {
    Wrapped {
        #[serde(default)]
        logs: Vec<RequestLogEntry>,
    },
    Legacy(Vec<RequestLogEntry>),
}

impl RequestLogsResponse {
    pub fn into_logs(self) -> Vec<RequestLogEntry> {
        match self {
            Self::Wrapped { logs } | Self::Legacy(logs) => logs,
        }
    }
}

impl RequestLogEntry {
    pub fn display_model(&self) -> &str {
        self.resolved_model.as_deref().unwrap_or(&self.model)
    }

    pub fn fast_state(&self) -> Option<bool> {
        let values = [
            self.requested_speed_label.as_deref(),
            self.configured_speed_label.as_deref(),
            self.requested_service_tier.as_deref(),
            self.configured_service_tier.as_deref(),
            self.response_service_tier.as_deref(),
        ];
        let mut has_signal = false;
        for value in values.into_iter().flatten() {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            has_signal = true;
            if value.eq_ignore_ascii_case("fast") || value.eq_ignore_ascii_case("priority") {
                return Some(true);
            }
        }
        has_signal.then_some(false)
    }
}

pub fn format_tok_per_second(metric: Option<&TokPerSecondMetric>) -> String {
    let Some(metric) = metric.filter(|metric| metric.kind == "value") else {
        return "—".into();
    };
    let Some(value) = metric
        .value
        .filter(|value| value.is_finite() && *value > 0.0)
    else {
        return "—".into();
    };
    let prefix = if metric.estimated { "~" } else { "" };
    if value >= 100.0 {
        format!("{prefix}{value:.0} tok/s")
    } else {
        format!("{prefix}{value:.1} tok/s")
    }
}

pub fn latest_request_logs(mut logs: Vec<RequestLogEntry>) -> Vec<RequestLogEntry> {
    logs.sort_by_key(|log| std::cmp::Reverse(log.timestamp));
    logs.truncate(10);
    logs
}

impl UsageResponse {
    pub fn latest_day_providers(self) -> Vec<UsageProvider> {
        let Some(day) = self.days.into_iter().max_by(|a, b| a.date.cmp(&b.date)) else {
            return Vec::new();
        };
        let mut totals = HashMap::<String, u64>::new();
        for model in day.models {
            *totals.entry(model.provider).or_default() += model.total_tokens;
        }
        totals
            .into_iter()
            .map(|(provider, total_tokens)| UsageProvider {
                provider,
                total_tokens,
            })
            .collect()
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitchState {
    pub auto_switch_threshold: u32,
    pub active_codex_account_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    pub id: String,
    pub alias: Option<String>,
    pub email: Option<String>,
    #[serde(default)]
    pub is_main: bool,
    #[serde(default)]
    pub paused: bool,
    pub quota: Option<AccountQuota>,
    #[serde(default)]
    pub needs_reauth: bool,
    pub health_label: Option<String>,
    pub health_summary: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuota {
    pub five_hour_percent: Option<f64>,
    pub five_hour_reset_at: Option<f64>,
    pub weekly_percent: Option<f64>,
    pub weekly_reset_at: Option<f64>,
    pub monthly_percent: Option<f64>,
    pub monthly_reset_at: Option<f64>,
    pub reset_credits: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ResetCreditConsumeResponse {
    #[serde(default)]
    pub code: String,
    pub remaining: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ResetCredit {
    pub granted_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ResetCreditsResponse {
    #[serde(default)]
    pub credits: Vec<ResetCredit>,
    #[serde(default)]
    pub available_count: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CodexAccountsResponse {
    #[serde(default)]
    pub accounts: Vec<CodexAccount>,
}

#[derive(Clone, Debug, Default)]
pub struct AccountView {
    pub id: String,
    pub identity: String,
    /// Auth kind that owns this account: "codex" | "oauth" | "key".
    pub kind: String,
    pub active: bool,
    pub health: String,
    pub quota: Option<Quota>,
    pub paused: bool,
    pub needs_reauth: bool,
    pub is_main: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub adapter: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub auth: String,
    pub default_model: Option<String>,
    pub responses_path: Option<String>,
    pub oauth_provider: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub free_tier: bool,
    #[serde(default)]
    pub key_optional: bool,
    pub codex_account_mode: Option<String>,
    #[serde(default)]
    pub base_url_choices: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderPresetAction {
    CodexAccount,
    OAuth(String),
    ApiKey,
    Unsupported,
}

/// Key-optional presets with a fixed registry-owned endpoint can be created without
/// a key. A supplied key still represents a distinct account allocation and is stored
/// in OCX's existing key pool.
pub fn supports_keyless_add(preset: &ProviderPreset) -> bool {
    preset.key_optional
        && !preset.base_url.is_empty()
        && preset.base_url_choices.is_empty()
        && !preset.base_url.contains(['{', '}'])
}

/// Cloudflare Workers AI is a free-tier preset whose endpoint needs the user's
/// account id substituted before OCX can create the provider row.
pub fn supports_account_id_base_url(preset: &ProviderPreset) -> bool {
    preset.id == "cloudflare-workers-ai"
        && preset.base_url_choices.is_empty()
        && preset.base_url.contains("{account_id}")
}

pub fn resolve_provider_base_url(
    preset: &ProviderPreset,
    account_id: Option<&str>,
) -> Result<String, &'static str> {
    if !supports_account_id_base_url(preset) {
        return Ok(preset.base_url.clone());
    }
    let account_id = account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Cloudflare account ID is required")?;
    if account_id.len() > 128
        || !account_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Cloudflare account ID contains invalid characters");
    }
    Ok(preset.base_url.replace("{account_id}", account_id))
}

pub fn provider_preset_action(preset: &ProviderPreset) -> ProviderPresetAction {
    if preset.id == "openai"
        && preset.auth.eq_ignore_ascii_case("forward")
        && preset.codex_account_mode.is_some()
    {
        return ProviderPresetAction::CodexAccount;
    }
    if preset.auth.eq_ignore_ascii_case("oauth") {
        return ProviderPresetAction::OAuth(
            preset
                .oauth_provider
                .clone()
                .unwrap_or_else(|| preset.id.clone()),
        );
    }
    let is_key = preset.auth.eq_ignore_ascii_case("key");
    let is_local = preset.auth.eq_ignore_ascii_case("local");
    if (is_key || is_local)
        && (!is_key || !preset.key_optional || supports_keyless_add(preset))
        && !preset.base_url.is_empty()
        && preset.base_url_choices.is_empty()
        && (!preset.base_url.contains(['{', '}']) || supports_account_id_base_url(preset))
    {
        return ProviderPresetAction::ApiKey;
    }
    ProviderPresetAction::Unsupported
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProviderPresetsResponse {
    #[serde(default)]
    pub providers: Vec<ProviderPreset>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthFlowResponse {
    pub flow_id: Option<String>,
    pub url: Option<String>,
    pub instructions: Option<String>,
    pub device_code: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusResponse {
    pub status: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub logged_in: bool,
    pub error: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCreateBody<'a> {
    pub name: &'a str,
    pub provider: ProviderCreateConfig<'a>,
    pub set_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCreateConfig<'a> {
    pub adapter: &'a str,
    pub base_url: &'a str,
    pub auth_mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responses_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<&'a str>,
}

pub fn provider_create_body<'a>(
    preset: &'a ProviderPreset,
    api_key: &'a str,
) -> Result<ProviderCreateBody<'a>, &'static str> {
    provider_create_body_with_api_key(preset, Some(api_key))
}

pub fn provider_create_body_with_api_key<'a>(
    preset: &'a ProviderPreset,
    api_key: Option<&'a str>,
) -> Result<ProviderCreateBody<'a>, &'static str> {
    provider_create_body_with_base_url(preset, api_key, &preset.base_url)
}

pub fn provider_create_body_with_base_url<'a>(
    preset: &'a ProviderPreset,
    api_key: Option<&'a str>,
    base_url: &'a str,
) -> Result<ProviderCreateBody<'a>, &'static str> {
    if provider_preset_action(preset) != ProviderPresetAction::ApiKey {
        return Err("This provider preset is not a supported key/local preset");
    }
    if preset.id.is_empty() || preset.adapter.is_empty() || base_url.is_empty() {
        return Err("This provider preset is incomplete");
    }
    if base_url.contains(['{', '}']) {
        return Err("This provider preset needs an endpoint value before creation");
    }
    Ok(ProviderCreateBody {
        name: &preset.id,
        provider: ProviderCreateConfig {
            adapter: &preset.adapter,
            base_url,
            auth_mode: if preset.auth.eq_ignore_ascii_case("local") {
                "local"
            } else {
                "key"
            },
            responses_path: preset.responses_path.as_deref(),
            default_model: preset.default_model.as_deref(),
            api_key,
        },
        set_default: false,
    })
}

#[derive(Clone, Debug, Default)]
pub struct ProviderView {
    pub name: String,
    pub label: String,
    pub quota: Option<Quota>,
    pub tokens: u64,
    pub accounts: Vec<AccountView>,
}

pub fn provider_base_label(provider: &ProviderView) -> String {
    let label = [" (Codex login)", " (AWS CodeWhisperer)"]
        .iter()
        .find_map(|suffix| provider.label.strip_suffix(suffix))
        .unwrap_or(&provider.label);
    label.to_string()
}

pub fn provider_header_label(provider: &ProviderView) -> String {
    let label = provider_base_label(provider);

    match provider.accounts.iter().find(|account| account.active) {
        Some(account) => format!("{label} ({})", account.identity),
        None => label,
    }
}

#[derive(Clone, Debug, Default)]
pub struct AccountPool {
    pub provider: String,
    pub accounts: Vec<AccountView>,
}

pub fn merge_providers(
    configs: &[ProviderConfig],
    reports: &[QuotaReport],
    usage: &[UsageProvider],
    pools: &[AccountPool],
) -> Vec<ProviderView> {
    let report_by_name: HashMap<&str, &QuotaReport> =
        reports.iter().map(|r| (r.provider.as_str(), r)).collect();
    let usage_by_name: HashMap<&str, &UsageProvider> =
        usage.iter().map(|u| (u.provider.as_str(), u)).collect();
    let pools_by_name: HashMap<&str, &AccountPool> =
        pools.iter().map(|p| (p.provider.as_str(), p)).collect();

    configs
        .iter()
        .filter(|config| !config.disabled)
        .map(|config| {
            let report = report_by_name.get(config.name.as_str()).copied();
            let usage = usage_by_name.get(config.name.as_str()).copied();
            let pool = pools_by_name.get(config.name.as_str()).copied();
            ProviderView {
                name: config.name.clone(),
                label: report
                    .and_then(|r| r.label.clone())
                    .unwrap_or_else(|| config.name.clone()),
                quota: report.map(|r| r.quota.clone()),
                tokens: usage.map_or(0, |u| u.total_tokens),
                accounts: pool.map_or_else(Vec::new, |p| p.accounts.clone()),
            }
        })
        .collect()
}

fn normalized_codex_email(email: Option<&str>) -> Option<String> {
    email
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .map(|email| email.to_ascii_lowercase())
}

fn same_codex_account(left: &CodexAccount, right: &CodexAccount) -> bool {
    match (
        normalized_codex_email(left.email.as_deref()),
        normalized_codex_email(right.email.as_deref()),
    ) {
        (Some(left_email), Some(right_email)) => left_email == right_email,
        _ => left.id == right.id,
    }
}

fn codex_account_is_main(account: &CodexAccount) -> bool {
    account.is_main || account.id == "__main__"
}

fn fill_optional<T>(target: &mut Option<T>, source: Option<T>) {
    if target.is_none() {
        *target = source;
    }
}

fn merge_account_quota(target: &mut Option<AccountQuota>, source: Option<AccountQuota>) {
    if target.is_none() {
        *target = source;
        return;
    }
    let Some(source) = source else {
        return;
    };
    let Some(target) = target.as_mut() else {
        return;
    };
    fill_optional(&mut target.five_hour_percent, source.five_hour_percent);
    fill_optional(&mut target.five_hour_reset_at, source.five_hour_reset_at);
    fill_optional(&mut target.weekly_percent, source.weekly_percent);
    fill_optional(&mut target.weekly_reset_at, source.weekly_reset_at);
    fill_optional(&mut target.monthly_percent, source.monthly_percent);
    fill_optional(&mut target.monthly_reset_at, source.monthly_reset_at);
    fill_optional(&mut target.reset_credits, source.reset_credits);
}

fn merge_codex_account(target: &mut CodexAccount, incoming: CodexAccount) {
    let incoming_is_main = codex_account_is_main(&incoming);
    let target_is_main = codex_account_is_main(target);
    let incoming_is_canonical_main = incoming.id == "__main__" && target.id != "__main__";
    let prefer_incoming = (incoming_is_main && !target_is_main) || incoming_is_canonical_main;

    let mut source = incoming;
    if prefer_incoming {
        std::mem::swap(target, &mut source);
    }

    target.is_main = codex_account_is_main(target) || codex_account_is_main(&source);
    target.paused |= source.paused;
    target.needs_reauth |= source.needs_reauth;
    fill_optional(&mut target.alias, source.alias);
    fill_optional(&mut target.email, source.email);
    fill_optional(&mut target.health_label, source.health_label);
    fill_optional(&mut target.health_summary, source.health_summary);
    merge_account_quota(&mut target.quota, source.quota);
}

fn dedupe_codex_accounts(accounts: Vec<CodexAccount>) -> Vec<CodexAccount> {
    let mut unique = Vec::with_capacity(accounts.len());
    for account in accounts {
        if let Some(existing) = unique
            .iter_mut()
            .find(|existing| same_codex_account(existing, &account))
        {
            merge_codex_account(existing, account);
        } else {
            unique.push(account);
        }
    }
    unique
}

pub fn codex_account_views(response: CodexAccountsResponse) -> Vec<AccountView> {
    dedupe_codex_accounts(response.accounts)
        .into_iter()
        .map(|account| {
            let is_main = codex_account_is_main(&account);
            let identity = account
                .alias
                .or(account.email)
                .unwrap_or_else(|| account.id.clone());
            let health = if account.needs_reauth {
                "Reauth required".to_string()
            } else {
                account
                    .health_label
                    .or(account.health_summary)
                    .unwrap_or_else(|| "Available".to_string())
            };
            let quota = account.quota.map(|q| Quota {
                five_hour_percent: q.five_hour_percent,
                five_hour_reset_at: q.five_hour_reset_at,
                weekly_percent: q.weekly_percent,
                weekly_reset_at: q.weekly_reset_at,
                monthly_percent: q.monthly_percent,
                monthly_reset_at: q.monthly_reset_at,
                reset_credits: q.reset_credits,
                ..Quota::default()
            });
            AccountView {
                id: account.id,
                identity,
                kind: "codex".into(),
                active: account.is_main,
                health,
                quota,
                paused: account.paused,
                needs_reauth: account.needs_reauth,
                is_main,
            }
        })
        .collect()
}

pub fn mark_codex_active_account(pools: &mut [AccountPool], active_id: Option<&str>) {
    let Some(active_id) = active_id else {
        return;
    };
    if let Some(pool) = pools.iter_mut().find(|pool| pool.provider == "openai") {
        for account in &mut pool.accounts {
            account.active = account.id == active_id;
        }
    }
}

/// Optimistically mark `id` active in `provider`'s pool; returns the previously
/// active account id (if any) so a failed switch can be reverted.
pub fn mark_active_account(
    pools: &mut [AccountPool],
    provider: &str,
    id: &str,
) -> Option<String> {
    let pool = pools.iter_mut().find(|pool| pool.provider == provider)?;
    let previous = pool
        .accounts
        .iter()
        .find(|account| account.active)
        .map(|account| account.id.clone());
    for account in &mut pool.accounts {
        account.active = account.id == id;
    }
    previous
}

/// Revert an optimistic active switch back to `id` (the previously active account).
pub fn restore_active_account(pools: &mut [AccountPool], provider: &str, id: &str) {
    if let Some(pool) = pools.iter_mut().find(|pool| pool.provider == provider) {
        for account in &mut pool.accounts {
            account.active = account.id == id;
        }
    }
}

pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else if value >= 100.0 {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000_000_000 {
        format_korean_unit(tokens, 1_000_000_000_000, "조")
    } else if tokens >= 100_000_000 {
        format_korean_unit(tokens, 100_000_000, "억")
    } else if tokens >= 10_000 {
        format_korean_unit(tokens, 10_000, "만")
    } else {
        tokens.to_string()
    }
}

fn format_korean_unit(value: u64, unit: u64, suffix: &str) -> String {
    let scaled = value as f64 / unit as f64;
    if scaled >= 100.0 || (scaled.fract().abs() < 0.05) {
        format!("{scaled:.0}{suffix}")
    } else {
        format!("{scaled:.1}{suffix}")
    }
}

pub fn format_percent(percent: f64) -> String {
    format!("{:.0}%", percent.clamp(0.0, 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_values_compactly() {
        assert_eq!(format_bytes(1_572_864), "1.5 MB");
        assert_eq!(format_tokens(1_250_000), "125만");
        assert_eq!(format_tokens(140_462_493), "1.4억");
        assert_eq!(format_percent(45.6), "46%");
    }

    #[test]
    fn request_logs_are_newest_first_and_limited_to_ten() {
        let logs = (0..12)
            .map(|timestamp| RequestLogEntry {
                timestamp,
                ..Default::default()
            })
            .collect();

        let logs = latest_request_logs(logs);

        assert_eq!(logs.len(), 10);
        assert_eq!(logs.first().map(|log| log.timestamp), Some(11));
        assert_eq!(logs.last().map(|log| log.timestamp), Some(2));
    }

    #[test]
    fn request_log_preserves_effort_and_resolves_fast_state() {
        let standard: RequestLogEntry = serde_json::from_str(
            r#"{
                "timestamp": 1785577719897,
                "provider": "openai",
                "model": "gpt-5.6-sol",
                "requestedEffort": "high",
                "responseServiceTier": "default"
            }"#,
        )
        .expect("standard log parses");
        let fast: RequestLogEntry = serde_json::from_str(
            r#"{
                "timestamp": 1785577719898,
                "provider": "openai",
                "model": "gpt-5.6-sol",
                "requestedEffort": "xhigh",
                "requestedSpeedLabel": "fast"
            }"#,
        )
        .expect("fast log parses");

        assert_eq!(standard.requested_effort.as_deref(), Some("high"));
        assert_eq!(standard.fast_state(), Some(false));
        assert_eq!(fast.requested_effort.as_deref(), Some("xhigh"));
        assert_eq!(fast.fast_state(), Some(true));
        assert_eq!(RequestLogEntry::default().fast_state(), None);
    }

    #[test]
    fn request_logs_accept_current_wrapper_and_legacy_array() {
        let wrapped: RequestLogsResponse = serde_json::from_str(
            r#"{"timeZone":"Asia/Seoul","total":1,"logs":[{"timestamp":2,"model":"new","displayMetrics":{"tokPerSecond":{"kind":"value","value":42.25,"estimated":true}}}]}"#,
        )
        .expect("wrapped logs parse");
        let legacy: RequestLogsResponse =
            serde_json::from_str(r#"[{"timestamp":1,"model":"old"}]"#).expect("legacy logs parse");

        let wrapped = wrapped.into_logs();
        assert_eq!(wrapped[0].model, "new");
        let metric = wrapped[0]
            .display_metrics
            .as_ref()
            .and_then(|metrics| metrics.tok_per_second.as_ref())
            .expect("nested tok/s metric is preserved");
        assert_eq!(metric.value, Some(42.25));
        assert!(metric.estimated);
        assert_eq!(legacy.into_logs()[0].model, "old");
    }

    #[test]
    fn formats_tok_per_second_like_the_gui() {
        let metric = |value, estimated| TokPerSecondMetric {
            kind: "value".into(),
            value: Some(value),
            estimated,
        };

        assert_eq!(
            format_tok_per_second(Some(&metric(99.94, false))),
            "99.9 tok/s"
        );
        assert_eq!(
            format_tok_per_second(Some(&metric(100.4, false))),
            "100 tok/s"
        );
        assert_eq!(
            format_tok_per_second(Some(&metric(42.26, true))),
            "~42.3 tok/s"
        );

        let unavailable = TokPerSecondMetric {
            kind: "unavailable".into(),
            value: Some(20.0),
            estimated: false,
        };
        assert_eq!(format_tok_per_second(None), "—");
        assert_eq!(format_tok_per_second(Some(&unavailable)), "—");
        assert_eq!(format_tok_per_second(Some(&metric(0.0, false))), "—");
        assert_eq!(
            format_tok_per_second(Some(&metric(f64::INFINITY, false))),
            "—"
        );
    }

    #[test]
    fn merge_is_exact_and_keeps_no_quota_usage() {
        let configs = vec![
            ProviderConfig {
                name: "openai".into(),
                ..Default::default()
            },
            ProviderConfig {
                name: "kiro".into(),
                ..Default::default()
            },
        ];
        let reports = vec![QuotaReport {
            provider: "openai-other".into(),
            quota: Quota {
                weekly_percent: Some(50.0),
                ..Default::default()
            },
            ..Default::default()
        }];
        let usage = vec![UsageProvider {
            provider: "kiro".into(),
            total_tokens: 42,
            ..Default::default()
        }];
        let merged = merge_providers(&configs, &reports, &usage, &[]);
        assert_eq!(merged.len(), 2);
        assert_eq!(
            merged
                .iter()
                .map(|provider| provider.name.as_str())
                .collect::<Vec<_>>(),
            vec!["openai", "kiro"]
        );
        assert!(merged[0].quota.is_none());
        assert_eq!(merged[1].tokens, 42);
    }

    #[test]
    fn disabled_providers_are_not_shown() {
        let configs = vec![ProviderConfig {
            name: "off".into(),
            disabled: true,
            ..Default::default()
        }];
        assert!(merge_providers(&configs, &[], &[], &[]).is_empty());
    }

    #[test]
    fn active_codex_account_follows_active_endpoint() {
        let mut pools = vec![AccountPool {
            provider: "openai".into(),
            accounts: vec![
                AccountView {
                    id: "first".into(),
                    active: true,
                    ..Default::default()
                },
                AccountView {
                    id: "second".into(),
                    ..Default::default()
                },
            ],
        }];

        mark_codex_active_account(&mut pools, Some("second"));

        assert!(!pools[0].accounts[0].active);
        assert!(pools[0].accounts[1].active);
    }

    #[test]
    fn active_switch_marks_one_account_and_returns_previous() {
        let mut pools = vec![AccountPool {
            provider: "opencode-go".into(),
            accounts: vec![
                AccountView {
                    id: "first".into(),
                    kind: "key".into(),
                    active: true,
                    ..Default::default()
                },
                AccountView {
                    id: "second".into(),
                    kind: "key".into(),
                    ..Default::default()
                },
            ],
        }];

        let previous = mark_active_account(&mut pools, "opencode-go", "second");

        assert_eq!(previous.as_deref(), Some("first"));
        assert!(!pools[0].accounts[0].active);
        assert!(pools[0].accounts[1].active);

        restore_active_account(&mut pools, "opencode-go", "first");
        assert!(pools[0].accounts[0].active);
        assert!(!pools[0].accounts[1].active);
    }

    #[test]
    fn codex_account_views_carry_the_codex_kind() {
        let views = codex_account_views(CodexAccountsResponse {
            accounts: vec![CodexAccount {
                id: "pool-a".into(),
                ..Default::default()
            }],
        });
        assert_eq!(views[0].kind, "codex");
    }

    #[test]
    fn codex_account_views_collapse_main_and_pool_rows_for_the_same_email() {
        let response: CodexAccountsResponse = serde_json::from_str(
            r#"{"accounts":[
                {"id":"pool-coseung","email":" user@example.com ","alias":"Primary","paused":true,"needsReauth":true,"quota":{"fiveHourPercent":25,"fiveHourResetAt":1787100000,"monthlyPercent":25}},
                {"id":"__main__","email":"USER@EXAMPLE.COM","isMain":true,"quota":{"weeklyPercent":50,"resetCredits":2}},
                {"id":"other","email":"other@example.com"}
            ]}"#,
        )
        .expect("account response parses");

        let accounts = codex_account_views(response);

        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].id, "__main__");
        assert_eq!(accounts[0].identity, "Primary");
        assert!(accounts[0].is_main);
        assert!(accounts[0].paused);
        assert!(accounts[0].needs_reauth);
        let quota = accounts[0].quota.as_ref().expect("merged quota");
        assert_eq!(quota.five_hour_percent, Some(25.0));
        assert_eq!(quota.five_hour_reset_at, Some(1787100000.0));
        assert_eq!(quota.weekly_percent, Some(50.0));
        assert_eq!(quota.monthly_percent, Some(25.0));
        assert_eq!(quota.reset_credits, Some(2));
    }

    #[test]
    fn codex_account_views_keep_different_emails_as_separate_accounts() {
        let accounts = codex_account_views(CodexAccountsResponse {
            accounts: vec![
                CodexAccount {
                    id: "first".into(),
                    email: Some("first@example.com".into()),
                    ..Default::default()
                },
                CodexAccount {
                    id: "second".into(),
                    email: Some("second@example.com".into()),
                    ..Default::default()
                },
            ],
        });

        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].id, "first");
        assert_eq!(accounts[1].id, "second");
    }

    #[test]
    fn codex_account_views_preserve_reset_credits() {
        let response: CodexAccountsResponse = serde_json::from_str(
            r#"{"accounts":[{"id":"__main__","quota":{"resetCredits":2}}]}"#,
        )
        .expect("account response parses");

        let accounts = codex_account_views(response);

        assert_eq!(accounts[0].quota.as_ref().and_then(|quota| quota.reset_credits), Some(2));
    }

    #[test]
    fn provider_header_replaces_legacy_suffix_with_active_account() {
        let provider = ProviderView {
            label: "OpenAI (Codex login)".into(),
            accounts: vec![
                AccountView {
                    identity: "first@example.com".into(),
                    ..Default::default()
                },
                AccountView {
                    identity: "active@example.com".into(),
                    active: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        assert_eq!(
            provider_header_label(&provider),
            "OpenAI (active@example.com)"
        );
    }

    #[test]
    fn provider_header_removes_legacy_suffix_without_active_account() {
        let provider = ProviderView {
            label: "Kiro (AWS CodeWhisperer)".into(),
            ..Default::default()
        };

        assert_eq!(provider_header_label(&provider), "Kiro");
    }

    #[test]
    fn provider_header_keeps_labels_without_legacy_suffix() {
        let provider = ProviderView {
            label: "xAI Grok".into(),
            accounts: vec![AccountView {
                identity: "masked@example.com".into(),
                active: true,
                ..Default::default()
            }],
            ..Default::default()
        };

        assert_eq!(
            provider_header_label(&provider),
            "xAI Grok (masked@example.com)"
        );
    }

    #[test]
    fn provider_header_preserves_meaningful_parenthesized_names() {
        let provider = ProviderView {
            label: "Acme (Enterprise)".into(),
            ..Default::default()
        };

        assert_eq!(provider_header_label(&provider), "Acme (Enterprise)");
    }

    #[test]
    fn codex_account_views_preserve_paused_state() {
        let response: CodexAccountsResponse = serde_json::from_str(
            r#"{"accounts":[
                {"id":"__main__","email":"a***@example.com","paused":true},
                {"id":"second","paused":false}
            ]}"#,
        )
        .expect("account response parses");
        let accounts = codex_account_views(response);

        assert!(accounts[0].paused);
        assert!(!accounts[1].paused);
    }

    #[test]
    fn codex_account_views_preserve_reauth_and_main_state() {
        let response: CodexAccountsResponse = serde_json::from_str(
            r#"{"accounts":[
                {"id":"__main__","needsReauth":true},
                {"id":"pool-2","needsReauth":true}
            ]}"#,
        )
        .expect("account response parses");
        let accounts = codex_account_views(response);

        assert!(accounts[0].needs_reauth);
        assert!(accounts[0].is_main);
        assert!(accounts[1].needs_reauth);
        assert!(!accounts[1].is_main);
    }

    #[test]
    fn provider_create_payload_matches_server_contract() {
        let preset = ProviderPreset {
            id: "anthropic".into(),
            adapter: "anthropic".into(),
            base_url: "https://api.example.test".into(),
            auth: "key".into(),
            default_model: Some("model-1".into()),
            responses_path: Some("/v1/responses".into()),
            ..Default::default()
        };
        let value = serde_json::to_value(provider_create_body(&preset, "secret").unwrap())
            .expect("payload serializes");

        assert_eq!(value["name"], "anthropic");
        assert_eq!(value["provider"]["authMode"], "key");
        assert_eq!(value["provider"]["apiKey"], "secret");
        assert_eq!(value["provider"]["responsesPath"], "/v1/responses");
        assert_eq!(value["setDefault"], false);
    }

    #[test]
    fn canonical_openai_preset_is_an_account_flow_never_a_key_overwrite() {
        let preset = ProviderPreset {
            id: "openai".into(),
            adapter: "openai-responses".into(),
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            auth: "forward".into(),
            codex_account_mode: Some("pool".into()),
            ..Default::default()
        };

        assert_eq!(
            provider_preset_action(&preset),
            ProviderPresetAction::CodexAccount
        );
        assert!(provider_create_body(&preset, "must-not-be-used").is_err());
    }

    #[test]
    fn presets_with_unrepresentable_auth_or_endpoint_contracts_are_unsupported() {
        for preset in [
            ProviderPreset {
                auth: "local".into(),
                ..Default::default()
            },
            ProviderPreset {
                auth: "key".into(),
                key_optional: true,
                ..Default::default()
            },
            ProviderPreset {
                auth: "key".into(),
                base_url_choices: vec![serde_json::json!({"id": "custom"})],
                ..Default::default()
            },
            ProviderPreset {
                auth: "key".into(),
                base_url: "https://example.test/{account}/v1".into(),
                ..Default::default()
            },
        ] {
            assert_eq!(
                provider_preset_action(&preset),
                ProviderPresetAction::Unsupported
            );
        }
    }

    #[test]
    fn opencode_free_supports_keyless_creation_and_key_pool_accounts() {
        let preset = ProviderPreset {
            id: "opencode-free".into(),
            auth: "key".into(),
            key_optional: true,
            adapter: "openai-chat".into(),
            base_url: "https://opencode.ai/zen/v1".into(),
            ..Default::default()
        };

        assert_eq!(
            provider_preset_action(&preset),
            ProviderPresetAction::ApiKey
        );

        let keyless =
            serde_json::to_value(provider_create_body_with_api_key(&preset, None).unwrap())
                .unwrap();
        assert!(keyless["provider"].get("apiKey").is_none());

        let keyed = serde_json::to_value(provider_create_body(&preset, "secret").unwrap()).unwrap();
        assert_eq!(keyed["provider"]["apiKey"], "secret");
    }

    #[test]
    fn fixed_key_optional_presets_support_keyless_creation() {
        for (id, adapter, base_url) in [
            ("litellm", "openai-chat", "http://localhost:4000/v1"),
            (
                "mimo-free",
                "mimo-free",
                "https://api.xiaomimimo.com/api/free-ai/openai/chat",
            ),
        ] {
            let preset = ProviderPreset {
                id: id.into(),
                auth: "key".into(),
                key_optional: true,
                adapter: adapter.into(),
                base_url: base_url.into(),
                ..Default::default()
            };
            assert_eq!(
                provider_preset_action(&preset),
                ProviderPresetAction::ApiKey
            );
            let payload =
                serde_json::to_value(provider_create_body_with_api_key(&preset, None).unwrap())
                    .unwrap();
            assert!(payload["provider"].get("apiKey").is_none());
        }
    }

    #[test]
    fn local_presets_use_local_auth_without_a_key() {
        let preset = ProviderPreset {
            id: "ollama".into(),
            auth: "local".into(),
            adapter: "openai-chat".into(),
            base_url: "http://localhost:11434/v1".into(),
            ..Default::default()
        };
        assert_eq!(provider_preset_action(&preset), ProviderPresetAction::ApiKey);
        let payload = serde_json::to_value(
            provider_create_body_with_api_key(&preset, None).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["provider"]["authMode"], "local");
        assert!(payload["provider"].get("apiKey").is_none());
    }

    #[test]
    fn cloudflare_free_preset_resolves_account_id_before_creation() {
        let preset = ProviderPreset {
            id: "cloudflare-workers-ai".into(),
            auth: "key".into(),
            free_tier: true,
            adapter: "openai-chat".into(),
            base_url: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1".into(),
            ..Default::default()
        };
        assert_eq!(
            provider_preset_action(&preset),
            ProviderPresetAction::ApiKey
        );
        let base_url = resolve_provider_base_url(&preset, Some("abc_123")).unwrap();
        assert_eq!(
            base_url,
            "https://api.cloudflare.com/client/v4/accounts/abc_123/ai/v1"
        );
        let payload = serde_json::to_value(
            provider_create_body_with_base_url(&preset, Some("secret"), &base_url).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["provider"]["baseUrl"], base_url);
    }

    #[test]
    fn usage_uses_latest_day_and_aggregates_provider_models() {
        let response = UsageResponse {
            days: vec![
                UsageDay {
                    date: "2026-07-29".into(),
                    models: vec![UsageDayModel {
                        provider: "openai".into(),
                        total_tokens: 10,
                    }],
                },
                UsageDay {
                    date: "2026-07-30".into(),
                    models: vec![
                        UsageDayModel {
                            provider: "openai".into(),
                            total_tokens: 20,
                        },
                        UsageDayModel {
                            provider: "openai".into(),
                            total_tokens: 30,
                        },
                    ],
                },
            ],
            ..Default::default()
        };
        let providers = response.latest_day_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].total_tokens, 50);
    }
}
