use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const FEATURED_MAX: usize = 5;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct SubagentModelsResponse {
    #[serde(default)]
    pub chosen: Vec<String>,
    #[serde(default)]
    pub available: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationModelOption {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub namespaced: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InjectionModelResponse {
    #[serde(default = "default_true")]
    pub multi_agent_guidance_enabled: bool,
    #[serde(default)]
    pub sync_codex_subagent_defaults: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub available: Vec<DelegationModelOption>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct SubagentModelsRequest<'a> {
    pub models: &'a [String],
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InjectionModelRequest {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub multi_agent_guidance_enabled: bool,
    pub sync_codex_subagent_defaults: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SubagentState {
    pub available: Vec<String>,
    pub chosen: Vec<String>,
    pub delegation_available: Vec<DelegationModelOption>,
    pub efforts: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub guidance_enabled: bool,
    pub sync_codex_defaults: bool,
    pub models_loaded: bool,
    pub injection_loaded: bool,
    pub dirty: bool,
    pub saving: bool,
    pub message: Option<String>,
}

impl SubagentState {
    pub fn apply_models(&mut self, response: SubagentModelsResponse) {
        self.available = unique_nonblank(response.available, usize::MAX);
        let available = self
            .available
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        self.chosen = unique_nonblank(response.chosen, FEATURED_MAX)
            .into_iter()
            .filter(|model| available.contains(model.as_str()))
            .collect();
        self.models_loaded = true;
    }

    pub fn apply_injection(&mut self, response: InjectionModelResponse) {
        self.guidance_enabled = response.multi_agent_guidance_enabled;
        self.sync_codex_defaults = response.sync_codex_subagent_defaults;
        self.model = response.model.filter(|value| !value.trim().is_empty());
        self.effort = response.effort.filter(|value| !value.trim().is_empty());
        self.efforts = unique_nonblank(response.efforts, usize::MAX);
        let mut seen = HashSet::new();
        self.delegation_available = response
            .available
            .into_iter()
            .filter(|option| !option.namespaced.trim().is_empty())
            .filter(|option| seen.insert(option.namespaced.clone()))
            .collect();
        self.injection_loaded = true;
    }

    pub fn loaded(&self) -> bool {
        self.models_loaded && self.injection_loaded
    }

    pub fn toggle_featured(&mut self, model: &str) -> bool {
        if let Some(index) = self.chosen.iter().position(|entry| entry == model) {
            self.chosen.remove(index);
            self.mark_dirty();
            return true;
        }
        if self.chosen.len() >= FEATURED_MAX || !self.available.iter().any(|entry| entry == model) {
            return false;
        }
        self.chosen.push(model.to_string());
        self.mark_dirty();
        true
    }

    pub fn move_featured(&mut self, index: usize, direction: isize) -> bool {
        let target = index as isize + direction;
        if index >= self.chosen.len() || target < 0 || target >= self.chosen.len() as isize {
            return false;
        }
        self.chosen.swap(index, target as usize);
        self.mark_dirty();
        true
    }

    pub fn cycle_model(&mut self) {
        let options = self
            .delegation_available
            .iter()
            .map(|option| option.namespaced.as_str())
            .collect::<Vec<_>>();
        self.model = next_selection(self.model.as_deref(), &options);
        if self.model.is_none() {
            self.effort = None;
            self.sync_codex_defaults = false;
        }
        self.mark_dirty();
    }

    pub fn cycle_effort(&mut self) {
        if self.model.is_none() {
            return;
        }
        let options = self.efforts.iter().map(String::as_str).collect::<Vec<_>>();
        self.effort = next_selection(self.effort.as_deref(), &options);
        self.mark_dirty();
    }

    pub fn toggle_guidance(&mut self) {
        self.guidance_enabled = !self.guidance_enabled;
        self.mark_dirty();
    }

    pub fn toggle_sync_defaults(&mut self) {
        if self.model.is_some() {
            self.sync_codex_defaults = !self.sync_codex_defaults;
            self.mark_dirty();
        }
    }

    pub fn mark_saved(&mut self) {
        self.dirty = false;
        self.saving = false;
        self.message = Some(format!("Saved {} featured models", self.chosen.len()));
    }

    fn mark_dirty(&mut self) {
        self.dirty = true;
        self.message = None;
    }

    pub fn injection_request(&self) -> InjectionModelRequest {
        InjectionModelRequest {
            model: self.model.clone(),
            effort: self.effort.clone(),
            multi_agent_guidance_enabled: self.guidance_enabled,
            sync_codex_subagent_defaults: self.sync_codex_defaults && self.model.is_some(),
        }
    }
}

fn unique_nonblank(values: Vec<String>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.clone()))
        .take(limit)
        .collect()
}

fn next_selection(current: Option<&str>, options: &[&str]) -> Option<String> {
    match current.and_then(|value| options.iter().position(|option| *option == value)) {
        None if current.is_none() => options.first().map(|value| (*value).to_string()),
        Some(index) if index + 1 < options.len() => Some(options[index + 1].to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_parse_dashboard_shapes_and_default_guidance_on() {
        let models: SubagentModelsResponse = serde_json::from_str(
            r#"{"chosen":["openai/gpt-5.6-sol"],"available":["openai/gpt-5.6-sol","kiro/auto"]}"#,
        )
        .unwrap();
        let injection: InjectionModelResponse = serde_json::from_str(
            r#"{"model":"openai/gpt-5.6-sol","effort":"high","efforts":["low","high"],"available":[{"provider":"openai","model":"gpt-5.6-sol","namespaced":"openai/gpt-5.6-sol"}]}"#,
        )
        .unwrap();

        assert_eq!(models.chosen, ["openai/gpt-5.6-sol"]);
        assert!(injection.multi_agent_guidance_enabled);
        assert_eq!(injection.available[0].namespaced, "openai/gpt-5.6-sol");
    }

    #[test]
    fn roster_is_filtered_deduplicated_limited_and_reorderable() {
        let mut state = SubagentState::default();
        state.apply_models(SubagentModelsResponse {
            available: (1..=6).map(|n| format!("p/m{n}")).collect(),
            chosen: vec!["p/m2".into(), "missing".into(), "p/m2".into()],
        });
        assert_eq!(state.chosen, ["p/m2"]);
        for model in ["p/m1", "p/m3", "p/m4", "p/m5"] {
            assert!(state.toggle_featured(model));
        }
        assert!(!state.toggle_featured("p/m6"));
        assert!(state.move_featured(4, -1));
        assert_eq!(state.chosen, ["p/m2", "p/m1", "p/m3", "p/m5", "p/m4"]);
        assert!(state.dirty);
    }

    #[test]
    fn model_and_effort_cycles_include_an_automatic_choice() {
        let mut state = SubagentState {
            delegation_available: vec![
                DelegationModelOption {
                    namespaced: "p/a".into(),
                    ..Default::default()
                },
                DelegationModelOption {
                    namespaced: "p/b".into(),
                    ..Default::default()
                },
            ],
            efforts: vec!["low".into(), "high".into()],
            sync_codex_defaults: true,
            ..Default::default()
        };
        state.cycle_model();
        assert_eq!(state.model.as_deref(), Some("p/a"));
        state.cycle_effort();
        assert_eq!(state.effort.as_deref(), Some("low"));
        state.cycle_model();
        state.cycle_model();
        assert_eq!(state.model, None);
        assert_eq!(state.effort, None);
        assert!(!state.sync_codex_defaults);
    }

    #[test]
    fn save_payloads_match_both_put_contracts() {
        let state = SubagentState {
            chosen: vec!["openai/gpt-5.6-sol".into(), "kiro/auto".into()],
            model: Some("openai/gpt-5.6-sol".into()),
            effort: Some("xhigh".into()),
            guidance_enabled: false,
            sync_codex_defaults: true,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(SubagentModelsRequest {
                models: &state.chosen
            })
            .unwrap(),
            serde_json::json!({"models":["openai/gpt-5.6-sol","kiro/auto"]})
        );
        assert_eq!(
            serde_json::to_value(state.injection_request()).unwrap(),
            serde_json::json!({
                "model":"openai/gpt-5.6-sol",
                "effort":"xhigh",
                "multiAgentGuidanceEnabled":false,
                "syncCodexSubagentDefaults":true
            })
        );
    }
}
