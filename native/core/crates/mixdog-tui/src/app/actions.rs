//! `SlashHost::open` by opener name, and what a picker's continuation asks for.
//!
//! The Node pickers received functions (`returnTo: openSettingsPicker`, `onAdvance: ...`); the Rust ones take continuations that
//! call [`AppCtx::run_action`] with an [`AppAction`], and the options of an opener arrive as JSON naming the target
//! (`returnTo: "settings"`). This module turns the JSON into each picker's options and runs the opener.

use std::collections::BTreeMap;
use std::rc::Rc;

use mixdog_tui_widgets::picker::IndexMode;
use serde_json::{Value, json};

use super::{AppAction, AppState};
use crate::pickers::common::{Onboarding, PickerFn, PickerHost, PickerPanel};
use crate::pickers::extensions::Extensions;
use crate::pickers::model::agents::{AgentsOptions, open_agents_picker};
use crate::pickers::model::output_style::{OutputStyleOptions, open_output_style_picker};
use crate::pickers::model::theme::{ThemeOptions, open_effort_picker, open_theme_picker};
use crate::pickers::model::web_search::{WebSearchOptions, open_web_search_picker};
use crate::pickers::model::workflow::{WorkflowOptions, open_workflow_picker};
use crate::pickers::model::{ModelPickerOptions, open_model_picker};
use crate::pickers::provider::{SetupOptions, onboarding_cancel, open_provider_setup, opener_named, output_style_advance, output_style_back, theme_advance, theme_back};
use crate::pickers::settings::{self, Opening};
use crate::slash::host::{Opener, Tone};
use crate::slash::notices::{truthy, value_text};

/// A continuation that runs `action`.
fn continuation(action: AppAction) -> PickerFn {
    Rc::new(move |host: &mut dyn PickerHost| host.run_action(action.clone()))
}

/// `options[key]` naming an opener: the continuation that opens it (`returnTo: "settings"`).
fn opens(options: &Value, key: &str) -> Option<PickerFn> {
    let name = options.get(key).and_then(Value::as_str)?;
    opener_named(name).map(|opener| continuation(AppAction::Open(opener, json!({}))))
}

fn text_option(options: &Value, key: &str) -> Option<String> {
    options.get(key).filter(|value| truthy(value)).map(value_text)
}

fn flag(options: &Value, key: &str) -> bool {
    options.get(key).is_some_and(truthy)
}

/// `handoffPanel`: the panel painted when a picker hands the surface back, from the member names Node used.
fn handoff_panel(options: &Value) -> Option<PickerPanel> {
    let value = options.get("handoffPanel").filter(|panel| panel.is_object())?;
    let mut panel = PickerPanel::new(&text_option(value, "title").unwrap_or_default());
    panel.description = text_option(value, "description").unwrap_or_default();
    panel.help = text_option(value, "help");
    panel.index_mode = match value.get("indexMode").and_then(Value::as_str) {
        Some("always") => Some(IndexMode::Always),
        Some("never") => Some(IndexMode::Never),
        Some("auto") => Some(IndexMode::Auto),
        _ => None,
    };
    panel.picker_key = text_option(value, "pickerKey");
    panel.loading = flag(value, "loading");
    Some(panel)
}

/// `options.onboarding`: the wizard's hooks for the theme step or the output style step.
fn onboarding(options: &Value, advance: AppAction, back: AppAction) -> Option<Onboarding> {
    options.get("onboarding").filter(|hooks| hooks.is_object())?;
    Some(Onboarding {
        on_advance: Some(continuation(advance)),
        on_back: Some(continuation(back)),
        on_cancel: Some(continuation(AppAction::OnboardingCancel)),
    })
}

impl AppState {
    /// Opens the picker or panel `opener` names with `options` (`{}` for none). An open that needs a part which is running right
    /// now (the extension pickers, mid-call) is queued and runs when that call returns.
    pub(crate) fn open_now(&mut self, opener: Opener, options: Value) -> Result<(), String> {
        let result = self.open_one(opener, options);
        self.drain_pending_opens();
        result
    }

    /// The opens that were queued behind a running call, in order; a failure is a notice.
    pub(crate) fn drain_pending_opens(&mut self) {
        while self.extensions.is_some() {
            let Some((opener, options)) = self.pending_opens.pop_front() else { break };
            if let Err(error) = self.open_one(opener, options) {
                self.notice(&format!("panel failed to open: {error}"), Tone::Error);
            }
        }
    }

    /// Runs `run` on the extension pickers' state, taken out for the call; `None` when a call into it is already running.
    pub(crate) fn with_extensions<R>(&mut self, run: impl FnOnce(&mut Extensions, &mut AppState) -> R) -> Option<R> {
        let mut extensions = self.extensions.take()?;
        let result = run(&mut extensions, self);
        self.extensions = Some(extensions);
        self.drain_pending_opens();
        Some(result)
    }

    fn open_one(&mut self, opener: Opener, options: Value) -> Result<(), String> {
        // The continue row of a provider setup that a picker asked for: the picker's own continuation runs
        // ([`AppState::hold_continuation`]).
        if let Some(id) = options.get("continuation").and_then(Value::as_u64) {
            self.run_continuation(id);
            return Ok(());
        }
        match opener {
            Opener::Model => open_model_picker(
                self,
                ModelPickerOptions {
                    refresh_models: flag(&options, "refreshModels"),
                    return_to: opens(&options, "returnTo"),
                    return_label: text_option(&options, "returnLabel"),
                    return_on_nested_cancel: flag(&options, "returnOnNestedCancel"),
                    handoff_panel: handoff_panel(&options),
                    on_after_select: opens(&options, "onAfterSelect"),
                    ..ModelPickerOptions::default()
                },
            ),
            Opener::WebSearch => open_web_search_picker(
                self,
                WebSearchOptions {
                    route_override: options.get("routeOverride").filter(|route| route.is_object()).cloned(),
                    return_to: opens(&options, "returnTo"),
                    return_label: text_option(&options, "returnLabel"),
                    return_on_nested_cancel: flag(&options, "returnOnNestedCancel"),
                },
            ),
            Opener::Agents => {
                let route_overrides: BTreeMap<String, Value> = options
                    .get("routeOverrides")
                    .and_then(Value::as_object)
                    .map(|routes| routes.iter().map(|(id, route)| (id.clone(), route.clone())).collect())
                    .unwrap_or_default();
                open_agents_picker(
                    self,
                    AgentsOptions {
                        refresh_models: flag(&options, "refreshModels"),
                        route_overrides,
                        initial_agent_id: text_option(&options, "initialAgentId").unwrap_or_default(),
                    },
                );
            }
            Opener::Workflow => open_workflow_picker(
                self,
                WorkflowOptions { return_to: opens(&options, "returnTo"), handoff_panel: handoff_panel(&options) },
            ),
            Opener::OutputStyle => open_output_style_picker(
                self,
                OutputStyleOptions {
                    return_to: opens(&options, "returnTo"),
                    handoff_panel: handoff_panel(&options),
                    onboarding: onboarding(&options, AppAction::OutputStyleAdvance, AppAction::OutputStyleBack),
                    confirm_bar: None,
                },
            ),
            Opener::Theme => open_theme_picker(
                self,
                ThemeOptions {
                    return_to: opens(&options, "returnTo"),
                    handoff_panel: handoff_panel(&options),
                    onboarding: onboarding(&options, AppAction::ThemeAdvance, AppAction::ThemeBack),
                    confirm_bar: None,
                },
            ),
            Opener::Effort => open_effort_picker(self),
            Opener::ProviderSetup => open_provider_setup(self, SetupOptions::from_value(&options)),
            Opener::Settings | Opener::AutoClear | Opener::Profile | Opener::Update | Opener::Developer => {
                match settings::open(self, opener, &options) {
                    Opening::Open(picker) => self.settings_picker = Some(picker),
                    Opening::Closed | Opening::NotMine => {}
                }
            }
            Opener::Mcp
            | Opener::McpServers
            | Opener::Skills
            | Opener::ProjectSkills
            | Opener::Plugins
            | Opener::MemoryCore
            | Opener::Project
            | Opener::Resume => {
                if self.extensions.is_none() {
                    self.pending_opens.push_back((opener, options));
                } else {
                    self.with_extensions(|extensions, host| extensions.open(host, opener, &options));
                }
            }
            Opener::Usage => {
                let argument = match &options {
                    Value::String(text) => text.clone(),
                    _ => String::new(),
                };
                let request = crate::panels::usage::open_usage_panel(self, &argument);
                self.usage_requests.push_back(request);
            }
            Opener::Context => {
                crate::panels::context::open_context_panel(self);
            }
        }
        Ok(())
    }

    /// Runs what a continuation asked for.
    pub(crate) fn apply_action(&mut self, action: AppAction) {
        match action {
            AppAction::Open(opener, options) => {
                if let Err(error) = self.open_now(opener, options) {
                    self.notice(&format!("panel failed to open: {error}"), Tone::Error);
                }
            }
            AppAction::ThemeAdvance => theme_advance(self),
            AppAction::ThemeBack => theme_back(self),
            AppAction::OutputStyleAdvance => output_style_advance(self),
            AppAction::OutputStyleBack => output_style_back(self),
            AppAction::OnboardingCancel => onboarding_cancel(self),
        }
    }
}
