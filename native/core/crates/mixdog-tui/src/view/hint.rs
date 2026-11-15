//! The welcome-screen prompt hint (`src/tui/app/use-welcome-prompt-hint.mjs`). A random starter tip is pinned for the
//! process; a problem of the setup (no usable provider, no model, the solo workflow, a default web-search route on a model
//! without native search, an error toast) replaces it with a tip that names the fix. The probes read the store; a probe
//! that fails leaves the starter tip alone. Dismissal only counts while the hint row is on screen.

use mixdog_js::{js_to_lowercase, js_trim, value_to_string};
use serde_json::{Value, json};

use super::format::{conditional_hints, provider_setup_has_usable_provider, random_welcome_prompt_hint};

/// The store calls the probes make: `None` when the store has no such method (the optional call `store.method?.()` of the
/// Node code did nothing), `Some(Err(_))` for a rejection.
pub trait WelcomeProbes {
    fn call(&mut self, method: &str, args: Value) -> Option<Result<Value, String>>;
}

/// What the probes look at; the probes run again when one of them changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HintInputs {
    pub provider: String,
    pub model: String,
    /// `state.workflow`.
    pub workflow: Value,
    /// The signature of the latest error toast, empty for none.
    pub toast_error_signature: String,
}

impl HintInputs {
    fn workflow_id(&self) -> Option<&Value> {
        self.workflow.get("id").filter(|id| !id.is_null())
    }
}

/// The state of the hint.
#[derive(Clone, Debug)]
pub struct WelcomePromptHint {
    tip: String,
    dismissed: bool,
    conditional: String,
    probed: Option<(String, String, Option<String>, String)>,
}

impl Default for WelcomePromptHint {
    fn default() -> Self {
        Self::with_tip(random_welcome_prompt_hint())
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value ?? '')` of a field the probes compare with a word, trimmed.
fn field_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    }
}

impl WelcomePromptHint {
    /// A hint that shows `tip` as the starter tip.
    pub fn with_tip(tip: &str) -> Self {
        Self { tip: tip.to_owned(), dismissed: false, conditional: String::new(), probed: None }
    }

    /// The starter tip pinned for the process.
    pub fn tip(&self) -> &str {
        &self.tip
    }

    pub fn dismissed(&self) -> bool {
        self.dismissed
    }

    /// The tip that names the fix of a setup problem, empty when there is none.
    pub fn conditional(&self) -> &str {
        &self.conditional
    }

    /// `dismissWelcomePromptHint()`: the draft gained its first character; it counts only while the hint row is on screen
    /// (`visible`, [`crate::surface::layout::ShellRefs::welcome_prompt_hint_visible`]) and never flips back.
    pub fn dismiss(&mut self, visible: bool) {
        if visible {
            self.dismissed = true;
        }
    }

    /// The probes of one run of the Node effect: the conditional tip as it follows from the store. A failed or missing probe
    /// is skipped, so the generic tip stays.
    pub fn probe(store: &mut dyn WelcomeProbes, inputs: &HintInputs) -> String {
        // The no-model and web-search-default probes both read the quick model list: fetched once per run, and a failed read
        // is asked again by the next probe that needs it.
        let mut quick_models: Option<Value> = None;
        let mut list_quick_models = |store: &mut dyn WelcomeProbes| -> Option<Value> {
            if quick_models.is_none() {
                match store.call("listProviderModels", json!({ "quick": true })) {
                    None => quick_models = Some(json!([])),
                    Some(Ok(models)) => quick_models = Some(if truthy(Some(&models)) { models } else { json!([]) }),
                    Some(Err(_)) => return None,
                }
            }
            quick_models.clone()
        };

        let mut next = "";
        if let Some(Ok(setup)) = store.call("getProviderSetup", json!({}))
            && truthy(Some(&setup))
            && !provider_setup_has_usable_provider(&setup)
        {
            next = conditional_hints::NO_PROVIDER;
        }
        if next.is_empty() {
            if js_trim(&inputs.provider).is_empty() || js_trim(&inputs.model).is_empty() {
                next = conditional_hints::NO_MODEL;
            } else if let Some(models) = list_quick_models(&mut *store)
                && models.as_array().is_some_and(Vec::is_empty)
            {
                next = conditional_hints::NO_MODEL;
            }
        }
        let active_workflow = active_workflow_summary(store, &inputs.workflow);
        let active_id = {
            let from_summary = active_workflow.as_ref().and_then(|summary| summary.get("id"));
            if truthy(from_summary) { field_text(from_summary) } else { field_text(inputs.workflow_id()) }
        };
        if next.is_empty() && js_to_lowercase(&active_id) == "solo" {
            next = conditional_hints::SOLO_WORKFLOW;
        }
        if next.is_empty() {
            let route = match store.call("getWebSearchRoute", json!({})) {
                Some(Ok(route)) if truthy(Some(&route)) => route,
                _ => Value::Null,
            };
            let default_route = js_to_lowercase(&field_text(route.get("provider"))) == "default" && js_to_lowercase(&field_text(route.get("model"))) == "default";
            if default_route
                && let Some(models) = list_quick_models(&mut *store)
                && let Some(current) = models.as_array().and_then(|models| {
                    models.iter().find(|model| {
                        model.get("provider").and_then(Value::as_str) == Some(inputs.provider.as_str())
                            && model.get("id").and_then(Value::as_str) == Some(inputs.model.as_str())
                    })
                })
                && current.get("supportsWebSearch") != Some(&Value::Bool(true))
            {
                next = conditional_hints::WEB_SEARCH_DEFAULT_UNSUPPORTED;
            }
        }
        if next.is_empty() && !inputs.toast_error_signature.is_empty() {
            next = conditional_hints::ERROR;
        }
        next.to_owned()
    }

    /// The effect of the Node hook: the probes run when the store, the provider, the model, the workflow id or the error
    /// signature changed since the last run. Returns whether the conditional tip changed.
    pub fn refresh(&mut self, store: &mut dyn WelcomeProbes, inputs: &HintInputs) -> bool {
        let key = (inputs.provider.clone(), inputs.model.clone(), inputs.workflow_id().map(value_to_string), inputs.toast_error_signature.clone());
        if self.probed.as_ref() == Some(&key) {
            return false;
        }
        self.probed = Some(key);
        let next = Self::probe(store, inputs);
        if next == self.conditional {
            return false;
        }
        self.conditional = next;
        true
    }

    /// Runs the probes again whatever the inputs are (the store was replaced).
    pub fn invalidate(&mut self) {
        self.probed = None;
    }
}

/// `activeWorkflowSummaryForStore(store, workflow)`: the workflow marked active, else the one with the state's id; none when
/// the list cannot be read.
fn active_workflow_summary(store: &mut dyn WelcomeProbes, workflow: &Value) -> Option<Value> {
    let listed = match store.call("listWorkflows", json!({})) {
        None => json!([]),
        Some(Ok(listed)) if truthy(Some(&listed)) => listed,
        Some(Ok(_)) => json!([]),
        Some(Err(_)) => return None,
    };
    let workflows = listed.as_array()?;
    workflows
        .iter()
        .find(|item| truthy(item.get("active")))
        .or_else(|| workflows.iter().find(|item| item.get("id") == workflow.get("id")))
        .cloned()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// A store of canned answers that counts the calls.
    #[derive(Default)]
    struct Canned {
        answers: HashMap<&'static str, Result<Value, String>>,
        calls: HashMap<String, usize>,
    }

    impl WelcomeProbes for Canned {
        fn call(&mut self, method: &str, _args: Value) -> Option<Result<Value, String>> {
            *self.calls.entry(method.to_owned()).or_default() += 1;
            self.answers.get(method).cloned()
        }
    }

    fn ready_store() -> Canned {
        let mut store = Canned::default();
        store.answers.insert("getProviderSetup", Ok(json!({ "api": [{ "id": "p1", "usable": true }], "oauth": [] })));
        store.answers.insert("listProviderModels", Ok(json!([{ "provider": "p1", "id": "m1", "supportsWebSearch": true }])));
        store.answers.insert("getWebSearchRoute", Ok(json!({ "provider": "p1", "model": "m1" })));
        store
    }

    fn inputs(workflow: &str, toast: &str) -> HintInputs {
        HintInputs { provider: "p1".to_owned(), model: "m1".to_owned(), workflow: json!({ "id": workflow }), toast_error_signature: toast.to_owned() }
    }

    #[test]
    fn the_hint_is_dismissed_only_while_its_row_is_visible_and_stays_dismissed() {
        let mut hint = WelcomePromptHint::default();
        assert!(!hint.tip().is_empty());
        hint.dismiss(false);
        assert!(!hint.dismissed());
        hint.dismiss(true);
        assert!(hint.dismissed());
        hint.dismiss(false);
        assert!(hint.dismissed());
    }

    #[test]
    fn a_toast_error_overrides_the_starter_tip_with_the_error_hint() {
        let mut hint = WelcomePromptHint::default();
        assert!(hint.refresh(&mut ready_store(), &inputs("team", "boom")));
        assert_eq!(hint.conditional(), conditional_hints::ERROR);
    }

    #[test]
    fn a_default_web_search_route_on_a_model_without_native_search_reads_the_model_list_once() {
        let mut store = ready_store();
        store.answers.insert("listProviderModels", Ok(json!([{ "provider": "p1", "id": "m1", "supportsWebSearch": false }])));
        store.answers.insert("getWebSearchRoute", Ok(json!({ "provider": "default", "model": "default" })));
        let mut hint = WelcomePromptHint::default();
        hint.refresh(&mut store, &inputs("team", ""));
        assert_eq!(hint.conditional(), conditional_hints::WEB_SEARCH_DEFAULT_UNSUPPORTED);
        assert_eq!(store.calls["listProviderModels"], 1, "the no-model probe fetches the list and the web-search probe reuses it");
    }

    #[test]
    fn a_store_with_no_usable_provider_wins_over_every_other_conditional_hint() {
        let mut store = ready_store();
        store.answers.insert("getProviderSetup", Ok(json!({ "api": [], "oauth": [] })));
        let mut hint = WelcomePromptHint::default();
        let mut none = inputs("solo", "boom");
        none.provider.clear();
        none.model.clear();
        hint.refresh(&mut store, &none);
        assert_eq!(hint.conditional(), conditional_hints::NO_PROVIDER);
    }

    #[test]
    fn the_solo_workflow_and_a_missing_model_have_their_own_tips() {
        let mut hint = WelcomePromptHint::default();
        hint.refresh(&mut ready_store(), &inputs("solo", ""));
        assert_eq!(hint.conditional(), conditional_hints::SOLO_WORKFLOW);
        let mut no_model = inputs("team", "");
        no_model.model.clear();
        assert!(hint.refresh(&mut ready_store(), &no_model));
        assert_eq!(hint.conditional(), conditional_hints::NO_MODEL);
        let mut empty = ready_store();
        empty.answers.insert("listProviderModels", Ok(json!([])));
        hint.invalidate();
        hint.refresh(&mut empty, &inputs("team", ""));
        assert_eq!(hint.conditional(), conditional_hints::NO_MODEL);
    }

    #[test]
    fn a_failed_probe_leaves_the_generic_tip_and_the_probes_wait_for_a_changed_input() {
        let mut store = ready_store();
        store.answers.insert("getProviderSetup", Err("down".to_owned()));
        store.answers.insert("listProviderModels", Err("down".to_owned()));
        store.answers.insert("getWebSearchRoute", Err("down".to_owned()));
        let mut hint = WelcomePromptHint::default();
        assert!(!hint.refresh(&mut store, &inputs("team", "")));
        assert_eq!(hint.conditional(), "");
        let before = store.calls["getProviderSetup"];
        hint.refresh(&mut store, &inputs("team", ""));
        assert_eq!(store.calls["getProviderSetup"], before, "the same inputs do not probe again");
        hint.refresh(&mut store, &inputs("team", "boom"));
        assert_eq!(hint.conditional(), conditional_hints::ERROR);
    }
}
