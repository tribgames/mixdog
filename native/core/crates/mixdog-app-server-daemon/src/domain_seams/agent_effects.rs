//! `AgentEffects` in production: what a change of the agent definitions sets going outside the
//! files (`session-runtime/boot/apis.mjs workflowAgentsApiFor`, `agent-editor.mjs
//! announceBotChange`, `workflow-agents-api/agent-route.mjs setAgentRoute`).
//!
//! The recorded Node run is `fixtures/agent-effects/golden.json` (`record-agent-effects.mjs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_agents::agents::AgentEffects;
use mixdog_core_agents::agents::OwnedRoutines;
use mixdog_core_domains::domains::ai_admin::agent_route_service::AgentRouteSetter;
use mixdog_services::channels::ChannelAdmin;
use mixdog_services::channels::ChannelLifecycle;
use mixdog_services::channels::ChannelRuntime;
use serde::Deserialize;
use serde_json::Value;

use super::profile_changes::AgentProfileChanges;

/// The schedules and webhooks of the channels, as an agent's purge and restore reach them.
#[async_trait]
pub trait RoutineChannels: Send + Sync {
    /// `deleteOwnedRoutines(agentId)` of `channel-admin.mjs`: the names removed.
    async fn delete_owned(&self, agent_id: &str) -> Result<OwnedRoutines, String>;
    /// `boot.reloadChannels()`: settles once the runtime re-armed the jobs, fails when it could not.
    async fn reload(&self) -> Result<(), String>;
    /// `boot.reloadChannelsSoon()`: the same reload, not waited for; a failure is only logged.
    fn reload_soon(&self);
}

/// The one route setter of the agents.
#[async_trait]
pub trait AgentRouteSetting: Send + Sync {
    async fn set(&self, agent_id: &str, route: &Obj) -> Result<(), String>;
}

/// [`RoutineChannels`] over the channel admin and runtime.
pub struct ServiceChannels {
    pub admin: Arc<ChannelAdmin>,
    pub runtime: Arc<ChannelRuntime>,
}

#[derive(Deserialize)]
struct Removed {
    schedules: Vec<String>,
    webhooks: Vec<String>,
}

#[async_trait]
impl RoutineChannels for ServiceChannels {
    async fn delete_owned(&self, agent_id: &str) -> Result<OwnedRoutines, String> {
        let removed = self.admin.delete_owned_routines(agent_id).await.map_err(|error| error.to_string())?;
        let Removed { schedules, webhooks } = serde_json::from_value(removed).map_err(|error| error.to_string())?;
        Ok(OwnedRoutines { schedules, webhooks })
    }

    async fn reload(&self) -> Result<(), String> {
        self.runtime.reload_config().await.map(|_| ())
    }

    fn reload_soon(&self) {
        let runtime = Arc::clone(&self.runtime);
        tokio::spawn(async move {
            if let Err(error) = runtime.reload_config().await {
                mixdog_rt::node_stderr!("[channels] schedule reload failed: {error}");
            }
        });
    }
}

#[async_trait]
impl AgentRouteSetting for AgentRouteSetter {
    async fn set(&self, agent_id: &str, route: &Obj) -> Result<(), String> {
        self.set_agent_route(agent_id, route).await.map(|_| ())
    }
}

pub struct DaemonAgentEffects {
    profile: Arc<AgentProfileChanges>,
    channels: Arc<dyn RoutineChannels>,
    routes: Arc<dyn AgentRouteSetting>,
}

impl DaemonAgentEffects {
    /// `profile` is the one `AgentProfileChanges` the session layer subscribes to.
    pub fn new(profile: Arc<AgentProfileChanges>, channels: Arc<dyn RoutineChannels>, routes: Arc<dyn AgentRouteSetting>) -> Self {
        Self { profile, channels, routes }
    }
}

/// `{ ...route }` of the route a save carries (any truthy JSON value reaches `setAgentRoute`):
/// an object as it is, an array or a string by index (a string one UTF-16 unit per key), any
/// other value adds no key.
fn spread(route: &Value) -> Result<Obj, String> {
    let mut out = Obj::new();
    match route {
        Value::Object(map) => out = map.clone(),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                out.insert(index.to_string(), item.clone());
            }
        }
        Value::String(text) => {
            for (index, unit) in text.chars().enumerate() {
                if unit.len_utf16() != 1 {
                    return Err("a route string with a character beyond the BMP cannot be spread into keys".to_owned());
                }
                out.insert(index.to_string(), Value::String(unit.to_string()));
            }
        }
        _ => {}
    }
    Ok(out)
}

#[async_trait]
impl AgentEffects for DaemonAgentEffects {
    async fn agents_changed(&self) {
        // The bot list is read from the files on every use, so Node's fresh scan
        // (`listCustomAgentIds`) has nothing to republish: only the runtimes are told.
        self.profile.publish().await;
    }

    async fn reload_routines(&self) -> Result<(), String> {
        self.channels.reload().await
    }

    async fn set_agent_route(&self, agent_id: &str, route: &Value) -> Result<(), String> {
        self.routes.set(agent_id, &spread(route)?).await
    }

    async fn delete_owned_routines(&self, agent_id: &str) -> Result<OwnedRoutines, String> {
        let removed = self.channels.delete_owned(agent_id).await?;
        if !removed.schedules.is_empty() || !removed.webhooks.is_empty() {
            self.channels.reload_soon();
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {

    use serde_json::json;

    use super::*;

    #[test]
    fn a_route_spreads_as_javascript_spreads_it() {
        assert_eq!(Value::Object(spread(&json!({ "provider": "openai" })).unwrap()), json!({ "provider": "openai" }));
        assert_eq!(Value::Object(spread(&json!("abc")).unwrap()), json!({ "0": "a", "1": "b", "2": "c" }));
        assert_eq!(Value::Object(spread(&json!(["x", "y"])).unwrap()), json!({ "0": "x", "1": "y" }));
        assert_eq!(Value::Object(spread(&json!(5)).unwrap()), json!({}));
        assert!(spread(&json!("😀")).is_err());
    }
}
