//! The provider setup picker and the first-run onboarding wizard (`app/provider-setup-picker.mjs`, `provider-usable.mjs`,
//! `provider-setup/{provider-items, api-key-actions, oauth-actions}.mjs`, `onboarding-steps.mjs`,
//! `onboarding/{step-data, models-step, role-model-picker, persist}.mjs`, `use-onboarding-start.mjs`).
//!
//! - [`format`]: the usable rule, the row labels, the status footer, the key-console address;
//! - [`items`]: the rows of the main list;
//! - [`panel`]: the panel the flows paint and what each row means;
//! - [`setup`]: the provider list, the API-key and OAuth action panels, the sign-in flow, credential removal;
//! - [`onboarding`]: the four-step wizard, its persistence and the first-run gate.
//!
//! The Node factories took the store, the surface and React setters as an injected bag and answered keys with closures stored
//! on the panel. Here [`ProviderHost`] is the application's side, and the application answers a key by calling [`select`],
//! [`cancel`], [`highlight`] or [`confirm`] with the panel's [`PanelOwner`]. Store calls are the host's synchronous
//! `store_call`; the one wait that is not a call, a sign-in the user finishes in a browser, is a flow the host watches
//! ([`ProviderHost::watch_oauth_flow`]) and answers with [`oauth_settled`].

pub mod format;
pub mod items;
pub mod onboarding;
pub mod panel;
pub mod setup;

use mixdog_tui_widgets::picker::MetaPart;
use serde_json::{Map, Value};

use crate::slash::host::{Opener, SlashHost, Tone};
use crate::surface::SurfaceClaim;

pub use items::ListOptions;
pub use onboarding::{
    AgentEntry, OnboardingState, Prefetch, finish_onboarding, onboarding_cancel, open_auth_step, open_models_step, open_role_model_picker,
    output_style_advance, output_style_back, prefetched_agents, prefetched_provider_models, resolve_onboarding_completed, start_onboarding, theme_advance,
    theme_back,
};
pub use panel::{PanelFooter, PanelOwner, PanelRow, ProviderPanel, ProviderRef, RowKind};
pub use setup::{
    ProviderSetup, SetupOptions, oauth_cancel_return, oauth_failure_return, oauth_settled, oauth_success_return, open_provider_setup, run_return_to,
};

/// The model-list helpers the wizard and the sort of the provider list use (`app/model-options.mjs`), which the model picker
/// owns: the application passes the one implementation.
pub trait ModelLabels {
    /// `providerDisplayRank(provider)`.
    fn provider_display_rank(&self, provider: &str) -> f64;
    /// `normalizeModelOptions(models)`.
    fn normalize_model_options(&self, models: &[Value]) -> Vec<Value>;
    /// `modelDescription(model)`.
    fn model_description(&self, model: &Value) -> String;
    /// `agentModelParts(route)`: the model, effort and speed columns of a route (`None` for no route).
    fn agent_model_parts(&self, route: Option<&Value>) -> Vec<MetaPart>;
}

/// What the provider setup and the wizard call back into.
pub trait ProviderHost: SlashHost + ModelLabels {
    /// `own.paint(panel)` under `claim`: the guarded write of the picker (`None` clears it and keeps the flow). The new
    /// claim, re-armed on the surface the write took, or `None` when the claim no longer held and nothing was written.
    fn paint_provider_panel(&mut self, claim: SurfaceClaim, panel: Option<ProviderPanel>) -> Option<SurfaceClaim>;

    /// `canOpenBrowser()`: whether a browser can plausibly open here.
    fn can_open_browser(&self) -> bool {
        use mixdog_term::os::{Platform, can_open_browser, is_wsl_host, process_env};
        can_open_browser(&process_env, Platform::current(), is_wsl_host())
    }

    /// `openInBrowser(url)`: best effort, nothing is reported.
    fn open_in_browser(&mut self, url: &str) {
        mixdog_term::os::open_in_browser(url);
    }

    /// Starts waiting for the sign-in flow `flow_id` (`OAuthKind::Provider`) to settle; the host answers with
    /// [`oauth_settled`] with the flow's final status, or the error that ended the wait.
    fn watch_oauth_flow(&mut self, flow_id: &str);

    /// The provider setup flow the host holds, taken out for the length of one event.
    fn take_provider_flow(&mut self) -> Option<ProviderSetup>;
    /// Holds `flow` as the provider setup flow (replacing any).
    fn put_provider_flow(&mut self, flow: ProviderSetup);
    /// Whether a flow is held now.
    fn has_provider_flow(&self) -> bool;

    /// The wizard state (`onboardingRef`).
    fn onboarding(&mut self) -> &mut OnboardingState;
    /// `setOnboardingActive(active)`.
    fn set_onboarding_active(&mut self, active: bool);
    /// Reads what `wants` names (`listProviderModels`, `listAgents`) off the UI thread and answers with
    /// [`prefetched_provider_models`] (carrying `wants.seq`) and [`prefetched_agents`]: the background prefetch of Step 2's data.
    fn start_step2_prefetch(&mut self, wants: Prefetch);
    /// `providerModelsCacheRef.current = { models, at }`.
    fn set_provider_models_cache(&mut self, models: &[Value], at_ms: u64);
}

/// Where a flow goes next: what the Node options carried as `returnTo`, `onContinue`, `onCancel` and a confirm bar's
/// `onConfirm`.
#[derive(Clone, Debug, PartialEq)]
pub enum Callback {
    /// Opens a picker or panel by name.
    Open(Opener, Value),
    /// Step 1 of the wizard.
    OnboardingAuthStep,
    /// Step 2 of the wizard.
    OnboardingModelsStep,
    /// Esc or cancel anywhere in the wizard: a confirmed skip.
    OnboardingSkip,
}

/// Runs a callback.
pub fn run_callback(host: &mut dyn ProviderHost, callback: &Callback) {
    match callback {
        Callback::Open(opener, options) => {
            if let Err(error) = host.open(*opener, options.clone()) {
                host.push_notice(&error, Tone::Error);
            }
        }
        Callback::OnboardingAuthStep => open_auth_step(host),
        Callback::OnboardingModelsStep => open_models_step(host),
        Callback::OnboardingSkip => onboarding_cancel(host),
    }
}

const OPENERS: [Opener; 23] = [
    Opener::Model,
    Opener::WebSearch,
    Opener::Agents,
    Opener::Workflow,
    Opener::OutputStyle,
    Opener::Theme,
    Opener::Effort,
    Opener::Project,
    Opener::Mcp,
    Opener::McpServers,
    Opener::Skills,
    Opener::ProjectSkills,
    Opener::Plugins,
    Opener::ProviderSetup,
    Opener::MemoryCore,
    Opener::Settings,
    Opener::AutoClear,
    Opener::Resume,
    Opener::Usage,
    Opener::Context,
    Opener::Profile,
    Opener::Update,
    Opener::Developer,
];

/// The opener called `name` in recordings (`Opener::as_str`).
pub fn opener_named(name: &str) -> Option<Opener> {
    OPENERS.into_iter().find(|opener| opener.as_str() == name)
}

/// A return target from its option form: `{ "opener": name, "options": {...} }`.
pub(crate) fn callback_from_value(value: &Value) -> Option<Callback> {
    let opener = opener_named(value.get("opener")?.as_str()?)?;
    Some(Callback::Open(opener, value.get("options").cloned().unwrap_or_else(|| Value::Object(Map::new()))))
}

/// Runs the provider setup flow the host holds on `event`; the flow is put back unless the event replaced it.
fn with_flow(host: &mut dyn ProviderHost, event: impl FnOnce(&mut dyn ProviderHost, &mut ProviderSetup)) {
    let Some(mut flow) = host.take_provider_flow() else {
        return;
    };
    event(host, &mut flow);
    if !host.has_provider_flow() && !flow.is_closed() {
        host.put_provider_flow(flow);
    }
}

/// Enter on row `index` of the panel owned by `owner` (`onSelect`).
pub fn select(host: &mut dyn ProviderHost, owner: &PanelOwner, index: usize) {
    match owner {
        PanelOwner::ProviderSetup => with_flow(host, |host, flow| flow.select(host, index)),
        PanelOwner::OnboardingModels => onboarding::models_select(host, index),
        PanelOwner::OnboardingRoleModel(target) => onboarding::role_model_select(host, target, index),
    }
}

/// Esc on the panel owned by `owner` (`onCancel`).
pub fn cancel(host: &mut dyn ProviderHost, owner: &PanelOwner) {
    match owner {
        PanelOwner::ProviderSetup => with_flow(host, |host, flow| flow.cancel(host)),
        PanelOwner::OnboardingModels => onboarding::models_cancel(host),
        PanelOwner::OnboardingRoleModel(_) => open_models_step(host),
    }
}

/// The highlight moved to row `index` (`onHighlight`): the main list remembers the provider row.
pub fn highlight(host: &mut dyn ProviderHost, owner: &PanelOwner, index: usize) {
    if matches!(owner, PanelOwner::ProviderSetup) {
        with_flow(host, |_, flow| flow.highlight(index));
    }
}

/// A confirm bar button was chosen (`confirmBar.onConfirm(button)`).
pub fn confirm(host: &mut dyn ProviderHost, owner: &PanelOwner, button: &str) {
    match owner {
        PanelOwner::ProviderSetup => with_flow(host, |host, flow| flow.confirm(host)),
        PanelOwner::OnboardingModels => onboarding::models_confirm(host, button),
        PanelOwner::OnboardingRoleModel(_) => {}
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use mixdog_tui_widgets::picker::MetaPart;
    use serde_json::Value;

    use super::ModelLabels;

    /// The labels the tests use: the display ranks of `model-options.mjs`, models kept as they are.
    pub(crate) struct FakeLabels;

    impl ModelLabels for FakeLabels {
        fn provider_display_rank(&self, provider: &str) -> f64 {
            match provider.to_lowercase().as_str() {
                "default" => 0.0,
                "openai-oauth" => 10.0,
                "anthropic-oauth" => 20.0,
                "openai" | "openai-api" => 40.0,
                "anthropic" | "anthropic-api" => 50.0,
                "gemini" | "gemini-api" => 60.0,
                "openrouter" => 950.0,
                _ => 900.0,
            }
        }

        fn normalize_model_options(&self, models: &[Value]) -> Vec<Value> {
            models.iter().filter(|m| m["provider"].is_string() && m["id"].is_string()).cloned().collect()
        }

        fn model_description(&self, model: &Value) -> String {
            model["description"].as_str().unwrap_or_default().to_owned()
        }

        fn agent_model_parts(&self, route: Option<&Value>) -> Vec<MetaPart> {
            let model = route.and_then(|r| r["model"].as_str()).unwrap_or_default();
            let effort = route.and_then(|r| r["effort"].as_str()).unwrap_or_default();
            vec![MetaPart { text: model.to_owned(), width: 17 }, MetaPart { text: effort.to_owned(), width: 6 }, MetaPart { text: String::new(), width: 9 }]
        }
    }
}
