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
    fn malformed_response_is_not_an_empty_success() {
        assert!(serde_json::from_str::<QuotaResponse>("{}").is_err());
        assert!(serde_json::from_str::<QuotaResponse>(r#"{"generatedAt":1,"reports":null}"#).is_err());
    }
}
