use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub namespaced: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub native: bool,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct SelectedModelsResponse {
    #[serde(default)]
    pub selected: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct VisibilityTarget<'a> {
    pub id: &'a str,
    #[serde(skip_serializing_if = "is_false")]
    pub native: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ModelVisibilityRequest<'a> {
    pub scope: &'static str,
    pub provider: &'a str,
    pub targets: Vec<VisibilityTarget<'a>>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ModelsState {
    pub rows: Vec<ModelRow>,
    pub selected: BTreeMap<String, Vec<String>>,
    pub rows_loaded: bool,
    pub selected_loaded: bool,
    pub mutating: HashSet<String>,
    pub message: Option<String>,
}

impl ModelsState {
    pub fn apply_rows(&mut self, rows: Vec<ModelRow>) {
        self.rows = rows
            .into_iter()
            .filter(|row| !row.provider.trim().is_empty() && !row.id.trim().is_empty())
            .collect();
        self.rows.sort_by(|left, right| {
            left.provider
                .cmp(&right.provider)
                .then_with(|| left.id.cmp(&right.id))
        });
        self.rows_loaded = true;
    }

    pub fn apply_selected(&mut self, response: SelectedModelsResponse) {
        self.selected = response
            .selected
            .into_iter()
            .map(|(provider, ids)| {
                let mut seen = HashSet::new();
                let ids = ids
                    .into_iter()
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty() && seen.insert(id.clone()))
                    .collect();
                (provider, ids)
            })
            .collect();
        self.selected_loaded = true;
    }

    pub fn loaded(&self) -> bool {
        self.rows_loaded && self.selected_loaded
    }

    /// Mirrors gui/src/model-visibility.ts: native rows ignore provider
    /// allowlists, routed rows join a non-empty allowlist, and every row still
    /// observes its final disabled flag from /api/models.
    pub fn visible(&self, row: &ModelRow) -> bool {
        let included = row.native
            || self
                .selected
                .get(&row.provider)
                .map(|allowlist| allowlist.is_empty() || allowlist.contains(&row.id))
                .unwrap_or(true);
        included && !row.disabled
    }

    pub fn mutation_key(provider: &str, id: &str, native: bool) -> String {
        format!(
            "{provider}:{}:{id}",
            if native { "native" } else { "routed" }
        )
    }

    pub fn request(row: &ModelRow, enabled: bool) -> ModelVisibilityRequest<'_> {
        ModelVisibilityRequest {
            scope: "models",
            provider: &row.provider,
            targets: vec![VisibilityTarget {
                id: &row.id,
                native: row.native,
            }],
            enabled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(provider: &str, id: &str, disabled: bool, native: bool) -> ModelRow {
        ModelRow {
            provider: provider.into(),
            id: id.into(),
            namespaced: if native {
                id.into()
            } else {
                format!("{provider}/{id}")
            },
            disabled,
            native,
            display_name: None,
        }
    }

    #[test]
    fn effective_visibility_matches_the_dashboard_contract() {
        let mut state = ModelsState::default();
        state.apply_rows(vec![
            row("kiro", "auto", false, false),
            row("kiro", "blocked", true, false),
            row("kiro", "claude", false, false),
            row("openai", "gpt-native", false, true),
        ]);
        state.apply_selected(SelectedModelsResponse {
            selected: BTreeMap::from([("kiro".into(), vec!["auto".into(), "blocked".into()])]),
        });

        assert!(state.visible(&state.rows[0]));
        assert!(!state.visible(&state.rows[1]));
        assert!(!state.visible(&state.rows[2]));
        assert!(state.visible(&state.rows[3]));
    }

    #[test]
    fn toggle_payload_uses_the_existing_atomic_visibility_route() {
        let native = row("openai", "gpt-native", true, true);
        assert_eq!(
            serde_json::to_value(ModelsState::request(&native, true)).unwrap(),
            serde_json::json!({
                "scope": "models", "provider": "openai",
                "targets": [{"id": "gpt-native", "native": true}], "enabled": true
            })
        );
        let routed = row("kiro", "auto", false, false);
        assert_eq!(
            serde_json::to_value(ModelsState::request(&routed, false)).unwrap(),
            serde_json::json!({
                "scope": "models", "provider": "kiro",
                "targets": [{"id": "auto"}], "enabled": false
            })
        );
    }
}
