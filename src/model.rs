use serde::Deserialize;
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
    pub weekly_percent: Option<f64>,
    pub weekly_reset_at: Option<f64>,
    pub monthly_percent: Option<f64>,
    pub monthly_reset_at: Option<f64>,
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
    pub active: bool,
    pub health: String,
    pub quota: Option<Quota>,
    pub paused: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ProviderView {
    pub name: String,
    pub label: String,
    pub quota: Option<Quota>,
    pub tokens: u64,
    pub accounts: Vec<AccountView>,
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

pub fn codex_account_views(response: CodexAccountsResponse) -> Vec<AccountView> {
    response
        .accounts
        .into_iter()
        .map(|account| {
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
                weekly_percent: q.weekly_percent,
                weekly_reset_at: q.weekly_reset_at,
                monthly_percent: q.monthly_percent,
                monthly_reset_at: q.monthly_reset_at,
                ..Quota::default()
            });
            AccountView {
                id: account.id,
                identity,
                active: account.is_main,
                health,
                quota,
                paused: account.paused,
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
