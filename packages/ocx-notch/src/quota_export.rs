//! Read-only public quota projection; account aggregation never leaves Notch.
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaResponse {
    generated_at: u64,
    reports: Vec<QuotaReport>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuotaReport {
    provider: String,
    label: String,
    source: String,
    quota: Quota,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reverse_engineered: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Quota {
    #[serde(skip_serializing_if = "Option::is_none")]
    five_hour_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    five_hour_reset_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    weekly_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    weekly_reset_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    monthly_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    monthly_reset_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_windows: Option<Vec<Window>>,
    updated_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    label: String,
    percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<Vec<Segment>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    label: String,
    percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<u64>,
}

#[derive(Deserialize)]
struct DesktopState {
    rendered: Vec<ModelRoute>,
}

#[derive(Deserialize, Serialize)]
struct ModelRoute {
    name: String,
    route: String,
    label: String,
}

/// One provider's confirmed prompt-cache policy, as the proxy recorded it while the
/// request ran. Projected like every other field: unknown keys are dropped, so a
/// future server field never reaches the plugin file unannounced.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachePolicyRow {
    provider: String,
    model: String,
    control: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_retention: Option<String>,
    last_observed_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachePolicyResponse {
    #[serde(default)]
    rows: Vec<CachePolicyRow>,
}

/// One provider+model's cache effectiveness over the recent window, as the proxy aggregated
/// it. Projected like every other field: unknown keys are dropped, and a silent provider
/// keeps `status: "unreported"` (with an optional labelled reuse estimate) rather than a
/// fabricated hit ratio.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheEffectivenessRow {
    provider: String,
    model: String,
    control: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_retention: Option<String>,
    samples: u64,
    reported_samples: u64,
    read_tokens: u64,
    write_tokens: u64,
    input_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    hit_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    estimated_reuse_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_ttl: Option<String>,
    status: String,
    last_observed_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheEffectivenessResponse {
    #[serde(default)]
    rows: Vec<CacheEffectivenessRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudePolicy {
    #[serde(default)]
    model_map: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    schema_version: u8,
    source: &'static str,
    connection_origin: String,
    model_routes: Vec<ModelRoute>,
    model_map: std::collections::BTreeMap<String, String>,
    /// Confirmed per-provider prompt-cache policy. Additive under schemaVersion 1:
    /// a consumer that predates it ignores the key rather than failing.
    cache_policy: Vec<CachePolicyRow>,
    /// Per provider+model cache effectiveness (a hit rate over the window). Additive under
    /// schemaVersion 1; an older consumer ignores the key.
    cache_effectiveness: Vec<CacheEffectivenessRow>,
    #[serde(flatten)]
    quotas: QuotaResponse,
}

pub fn write(path: &Path) -> Result<(), &'static str> {
    crate::api::begin_poll();
    let origin = crate::api::connection_base_url();
    let remote = crate::api::is_remote();
    let quotas: QuotaResponse = crate::api::get_json("/api/provider-quotas", 30_000)
        .map_err(|_| "Could not query provider quotas on the selected connection")?;
    // Exact Desktop alias registry, not model-family guesses. Optional on older servers.
    let model_routes = crate::api::get_json::<DesktopState>("/api/claude-desktop", 20_000)
        .map(|state| state.rendered).unwrap_or_default();
    let model_map = crate::api::get_json::<ClaudePolicy>("/api/claude-code", 8_000)
        .map(|policy| policy.model_map).unwrap_or_default();
    // Optional on servers that predate the endpoint: an empty list is "not recorded",
    // never "no caching", and the plugin shows the policy it can confirm.
    let cache_policy = crate::api::get_json::<CachePolicyResponse>("/api/cache-policy", 20_000)
        .map(|response| response.rows).unwrap_or_default();
    // Optional on servers that predate the endpoint: an empty list is "not observed", never
    // "no caching". A silent provider stays "unreported" in the rows themselves.
    let cache_effectiveness = crate::api::get_json::<CacheEffectivenessResponse>("/api/cache-effectiveness", 20_000)
        .map(|response| response.rows).unwrap_or_default();
    if origin != crate::api::connection_base_url()
        || crate::api::poll_generation() != crate::api::connection::generation()
    {
        return Err("Connection changed while reading provider quotas");
    }
    let bytes = serde_json::to_vec(&Export {
        schema_version: 1,
        source: if remote { "remote" } else { "local" },
        connection_origin: origin,
        model_routes,
        model_map,
        cache_policy,
        cache_effectiveness,
        quotas,
    }).map_err(|_| "Could not encode provider quotas")?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|_| "Could not create provider quota output (destination must not exist)")?;
    file.write_all(&bytes).map_err(|_| "Could not write provider quota output")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_drops_unknown_fields_at_every_depth() {
        let input = serde_json::json!({
            "generatedAt": 1000, "token": "secret",
            "reports": [{"provider": "test", "label": "Test", "source": "api",
                "updatedAt": 1000, "aggregation": {"accountId": "private"},
                "quota": {"fiveHourPercent": 0, "monthlyPercent": 42.5, "updatedAt": 1000,
                    "accountId": "private", "customWindows": [{"label": "Daily", "percent": 1,
                        "token": "secret", "segments": [{"label": "Model", "percent": 2, "accountId": "private"}]}]}}]
        });
        let response: QuotaResponse = serde_json::from_value(input).unwrap();
        let out = serde_json::to_string(&response).unwrap();
        assert!(!out.contains("secret"));
        assert!(!out.contains("private"));
        assert!(!out.contains("aggregation"));
        assert!(out.contains("\"fiveHourPercent\":0.0"));
        assert!(out.contains("\"monthlyPercent\":42.5"));
    }

    #[test]
    fn alias_projection_exports_only_route_metadata() {
        let state: DesktopState = serde_json::from_value(serde_json::json!({
            "apiKey": "private", "rendered": [{"name": "claude-opus-alias", "route": "native/gpt-6.1-sol", "label": "Sol", "token": "private"}]
        })).unwrap();
        let out = serde_json::to_string(&state.rendered).unwrap();
        assert!(out.contains("native/gpt-6.1-sol"));
        assert!(!out.contains("private"));
    }

    #[test]
    fn cache_policy_projection_keeps_only_read_only_metadata() {
        let input = serde_json::json!({
            "generatedAt": 1000, "apiKey": "private",
            "rows": [{"provider": "opencode-go", "model": "deepseek-v4.1-flash",
                "control": "unknown", "requestedRetention": "long",
                "lastObservedAt": 1000, "accountId": "private"}]
        });
        let response: CachePolicyResponse = serde_json::from_value(input).unwrap();
        let out = serde_json::to_string(&response).unwrap();
        assert!(out.contains("\"control\":\"unknown\""));
        assert!(out.contains("\"requestedRetention\":\"long\""));
        assert!(!out.contains("private"));
        assert!(!out.contains("accountId"));
    }

    #[test]
    fn cache_policy_without_rows_is_empty_not_an_error() {
        let response: CachePolicyResponse =
            serde_json::from_value(serde_json::json!({"generatedAt": 1})).unwrap();
        assert!(response.rows.is_empty());
        let without_retention: CachePolicyResponse = serde_json::from_value(serde_json::json!({
            "rows": [{"provider": "anthropic", "model": "claude-opus-5.5",
                "control": "anthropic-breakpoints", "lastObservedAt": 5}]
        })).unwrap();
        assert!(without_retention.rows[0].requested_retention.is_none());
    }

    #[test]
    fn cache_effectiveness_projection_keeps_only_read_only_metadata() {
        let input = serde_json::json!({
            "generatedAt": 1000, "apiKey": "private",
            "rows": [{"provider": "openai", "model": "gpt-5.6-sol", "control": "upstream-managed",
                "requestedRetention": "short", "samples": 10, "reportedSamples": 9,
                "readTokens": 100, "writeTokens": 0, "inputTokens": 120,
                "hitRatio": 0.83, "estimatedReuseRatio": null, "observedTtl": "1h",
                "status": "hit", "lastObservedAt": 1000, "accountId": "private"}]
        });
        let response: CacheEffectivenessResponse = serde_json::from_value(input).unwrap();
        let out = serde_json::to_string(&response).unwrap();
        assert!(out.contains("\"hitRatio\":0.83"));
        assert!(out.contains("\"observedTtl\":\"1h\""));
        assert!(!out.contains("private"));
        assert!(!out.contains("accountId"));
    }

    #[test]
    fn cache_effectiveness_silent_provider_keeps_estimate_and_drops_null_ratios() {
        let response: CacheEffectivenessResponse =
            serde_json::from_value(serde_json::json!({"generatedAt": 1})).unwrap();
        assert!(response.rows.is_empty());
        let silent: CacheEffectivenessResponse = serde_json::from_value(serde_json::json!({
            "rows": [{"provider": "kiro", "model": "claude-opus-5", "control": "unknown",
                "samples": 4, "reportedSamples": 0, "readTokens": 0, "writeTokens": 0,
                "inputTokens": 0, "hitRatio": null, "estimatedReuseRatio": 0.99,
                "status": "unreported", "lastObservedAt": 3}]
        })).unwrap();
        let out = serde_json::to_string(&silent.rows[0]).unwrap();
        assert!(out.contains("\"estimatedReuseRatio\":0.99"));
        assert!(!out.contains("hitRatio"));
        assert!(!out.contains("observedTtl"));
    }

    #[test]
    fn malformed_response_is_not_an_empty_success() {
        assert!(serde_json::from_str::<QuotaResponse>("{}").is_err());
        assert!(serde_json::from_str::<QuotaResponse>(r#"{"generatedAt":1,"reports":null}"#).is_err());
    }
}
