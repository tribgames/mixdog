//! The Agents roster and the per-agent panel (`route-pickers/agents-picker.mjs`): pin an agent to a model through the nested
//! model picker, or switch it off.

use std::collections::BTreeMap;
use std::rc::Rc;

use mixdog_tui_widgets::picker::{IndexMode, MetaPart, PickerItem};
use mixdog_view_model::display::clean::clean;
use serde_json::{Value, json};

use super::catalog::CatalogKind;
use super::options::{agent_model_parts, agent_model_profile, text_of};
use super::picker::{ModelPickerOptions, open_model_picker};
use crate::pickers::common::{
    Own, PanelItem, PickerHandler, PickerHost, PickerPanel, check_row, reset_surfaces, run_deferred,
};
use crate::slash::host::Tone;
use crate::slash::notices::truthy;
use crate::surface::SurfaceKind;

/// The options of `openAgentsPicker(options)`.
#[derive(Clone, Default)]
pub struct AgentsOptions {
    /// `/agents refresh`: force the nested model picker to reload the provider catalog on the next agent open (the agents
    /// list itself is always fresh).
    pub refresh_models: bool,
    /// Routes shown instead of the saved ones, by agent id (a save in flight).
    pub route_overrides: BTreeMap<String, Value>,
    pub initial_agent_id: String,
}

fn not_used_meta() -> Vec<MetaPart> {
    vec![
        MetaPart { text: "(not used)".to_owned(), width: 17 },
        MetaPart { text: String::new(), width: 6 },
        MetaPart { text: String::new(), width: 4 },
    ]
}

fn is_disabled(agent: &Value) -> bool {
    agent.get("disabled") == Some(&Value::Bool(true))
}

/// The agent's own panel: "Set model..." opens the nested model picker with the agent's route; "Not used" writes disabled and
/// returns to the roster. Agents are either pinned to a model or switched off, the same two states the desktop panel offers
/// ("Follows Main" is web-search only).
fn open_agent_options(host: &mut dyn PickerHost, own: &Rc<Own>, agent: &Value, refresh_models: bool) {
    let mut set_model = check_row("model", "Set model\u{2026}", !is_disabled(agent));
    set_model.description = "Run this agent on a pinned model.".to_owned();
    let mut off = check_row("off", "Not used", is_disabled(agent));
    off.description = "Hide this agent from the Lead entirely.".to_owned();
    let mut panel = PickerPanel::new(&text_of(agent.get("label")));
    panel.description = "Pick a model for this agent, or turn it off.".to_owned();
    panel.help = Some("\u{2191}/\u{2193} Select \u{b7} Enter Choose \u{b7} Esc Back".to_owned());
    panel.items = vec![PanelItem::new(set_model, Value::Null), PanelItem::new(off, Value::Null)];
    panel.initial_index = Some(usize::from(is_disabled(agent)));
    panel.handler = Some(Rc::new(AgentOptionsHandler { own: Rc::clone(own), agent: agent.clone(), refresh_models }));
    own.paint(host, Some(panel));
}

struct AgentOptionsHandler {
    own: Rc<Own>,
    agent: Value,
    refresh_models: bool,
}

impl AgentOptionsHandler {
    fn label(&self) -> String {
        text_of(self.agent.get("label"))
    }

    fn id(&self) -> Value {
        self.agent.get("id").cloned().unwrap_or(Value::Null)
    }

    fn open_nested_model_picker(&self, host: &mut dyn PickerHost) {
        let (label, id) = (self.label(), self.id());
        let override_id = text_of(Some(&id));
        let save_label = label.clone();
        let save_id = id.clone();
        open_model_picker(
            host,
            ModelPickerOptions {
                title: Some(format!("{label} Model")),
                provider_description: Some("Choose a provider for this agent.".to_owned()),
                refresh_models: self.refresh_models,
                catalog: CatalogKind::Provider,
                current_route: self.agent.get("route").filter(|route| truthy(route)).cloned(),
                return_to: Some(Rc::new(|host: &mut dyn PickerHost| open_agents_picker(host, AgentsOptions::default()))),
                on_immediate_select: Some(Rc::new(move |host: &mut dyn PickerHost, route_input: &Value| {
                    open_agents_picker(
                        host,
                        AgentsOptions {
                            route_overrides: BTreeMap::from([(override_id.clone(), route_input.clone())]),
                            initial_agent_id: override_id.clone(),
                            ..AgentsOptions::default()
                        },
                    );
                })),
                on_select_route: Some(Rc::new(move |host: &mut dyn PickerHost, route_input: &Value, _selected: &Value, _effort: &Option<String>| {
                    let result = host.store_call("setAgentRoute", json!([save_id, route_input]))?;
                    if !truthy(&result) {
                        host.push_notice("Agent model save is already running.", Tone::Warn);
                        return Ok(Value::Null);
                    }
                    host.push_notice(&format!("{save_label} model set to {}", agent_model_profile(&result)), Tone::Info);
                    Ok(result)
                })),
                ..ModelPickerOptions::default()
            },
        );
    }

    fn turn_off(&self, host: &mut dyn PickerHost) {
        let label = self.label();
        // Post-ack handover back to Agents, bound to THIS keypress: a late ack must not overwrite whatever replaced this
        // panel meanwhile.
        let deferred = self.own.claim();
        match host.store_call("setAgentRoute", json!([self.id(), {"disabled": true}])) {
            Ok(result) if !truthy(&result) => {
                host.push_notice("Agent save is already running.", Tone::Warn);
                return;
            }
            Ok(_) => host.push_notice(&format!("{label} is no longer used."), Tone::Info),
            Err(error) => host.push_notice(&format!("could not turn off {label}: {error}"), Tone::Error),
        }
        run_deferred(host, deferred, |host| open_agents_picker(host, AgentsOptions::default()));
    }
}

impl PickerHandler for AgentOptionsHandler {
    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        if item.item.value == "off" {
            self.turn_off(host);
        } else {
            self.open_nested_model_picker(host);
        }
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        open_agents_picker(host, AgentsOptions::default());
    }
}

/// `openAgentsPicker(options)`.
pub fn open_agents_picker(host: &mut dyn PickerHost, options: AgentsOptions) {
    let own = Rc::new(Own::new(host.claim_surface(SurfaceKind::Picker)));
    // On a daemon-backed store this is a remote call.
    let agents = match host.store_call("listAgents", json!([])) {
        Ok(Value::Array(agents)) => agents,
        Ok(_) => Vec::new(),
        Err(error) => {
            host.push_notice(&format!("could not list agents: {error}"), Tone::Error);
            return;
        }
    };
    let initial_agent_id = clean(Some(&json!(options.initial_agent_id)));
    let items: Vec<PanelItem> = agents
        .iter()
        .map(|agent| {
            let id = text_of(agent.get("id"));
            let route_override = options.route_overrides.get(&id).filter(|route| truthy(route));
            let mut item = PickerItem::new(&id, &text_of(agent.get("label")));
            item.meta_parts = Some(if is_disabled(agent) && route_override.is_none() {
                not_used_meta()
            } else {
                let route = route_override.cloned().or_else(|| agent.get("route").filter(|route| truthy(route)).cloned());
                agent_model_parts(&route.unwrap_or_else(|| json!({})))
            });
            item.description = match text_of(agent.get("description")) {
                description if !description.is_empty() => description,
                _ => text_of(agent.get("definition").and_then(|definition| definition.get("description"))),
            };
            PanelItem::new(item, json!({"_agent": agent}))
        })
        .collect();
    if !own.owns(host) {
        return;
    }
    reset_surfaces(host, &own);
    let initial = items.iter().position(|item| item.item.value == initial_agent_id).unwrap_or(0);
    let mut panel = PickerPanel::new("Agents");
    panel.description = "Workflow agents available for agent tasks.".to_owned();
    panel.help = Some("\u{2191}/\u{2193} Select \u{b7} Enter Set Model \u{b7} Esc Back".to_owned());
    panel.index_mode = Some(IndexMode::Always);
    panel.label_width = Some(18);
    panel.meta_width = Some(33);
    panel.initial_index = Some(initial);
    panel.items = items;
    panel.handler = Some(Rc::new(AgentsHandler { own: Rc::clone(&own), refresh_models: options.refresh_models }));
    own.paint(host, Some(panel));
}

struct AgentsHandler {
    own: Rc<Own>,
    refresh_models: bool,
}

impl PickerHandler for AgentsHandler {
    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        if let Some(agent) = item.tag("_agent") {
            open_agent_options(host, &self.own, agent, self.refresh_models);
        }
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        self.own.close(host);
    }
}
