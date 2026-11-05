//! `setAgentRoute` (workflow-agents-api/agent-route.mjs): saving, clearing and switching an
//! agent's own route. The storage is [`AgentRoutes`]; what a saved change does to the agent's
//! chats is the [`AgentRoutePublisher`]'s (every host takes the route from its next turn).

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{Obj, clean, normalize_workflow_route, truthy};
use mixdog_ai::service::routes::{canonical_route_provider, route_chain, validate_route_chain_providers};
use serde_json::Value;

use super::chain::RouteContext;
use crate::config::{AgentRoutes, Config, RouteHome};

/// `publishAgentRouteChange(agentId, route)`: settles once every host took the route; one
/// failing host never fails the save.
#[async_trait]
pub trait AgentRoutePublisher: Send + Sync {
    async fn publish(&self, agent_id: &str, route: &Value);
}

/// The internal agents of `defaults/agents.json` (`isHiddenAgent`): they have no route.
pub const HIDDEN_AGENTS: [&str; 3] = ["explore-agent", "cycle1-agent", "title-agent"];

/// `normalizeAgentId`: the fixed roles (`maintainer`, `explore`) and their aliases.
fn normalize_agent_id(value: &str) -> &'static str {
    match slug(value).as_str() {
        "maint" | "maintenance" | "memory" | "maintainer" => "maintainer",
        "explore" => "explore",
        _ => "",
    }
}

/// `clean(value).toLowerCase().replace(/[\s_]+/g, '-')`.
fn slug(value: &str) -> String {
    let mut out = String::new();
    let mut run = false;
    for ch in mixdog_js::js_trim(value).to_lowercase().chars() {
        if ch.is_whitespace() || ch == '_' || ch == '\u{feff}' {
            if !run {
                out.push('-');
            }
            run = true;
        } else {
            out.push(ch);
            run = false;
        }
    }
    out
}

/// `agentEditorId(agentId)`: `normalizeAgentId || normalizeWorkflowId`; empty when neither.
pub fn agent_editor_id(value: &str) -> String {
    let role = normalize_agent_id(value);
    if !role.is_empty() {
        return role.to_owned();
    }
    let id = slug(value);
    let mut chars = id.chars();
    let ok = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'));
    if ok { id } else { String::new() }
}

pub struct AgentRouteSetter {
    pub routes: AgentRoutes,
    pub config: Config,
    pub context: Arc<dyn RouteContext>,
    pub publisher: Arc<dyn AgentRoutePublisher>,
    pub hidden: HashSet<String>,
}

fn spread(base: &Obj, extra: &[(&str, Value)]) -> Obj {
    let mut out = base.clone();
    for (k, v) in extra {
        out.insert((*k).to_owned(), v.clone());
    }
    out
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn object(value: Value) -> Obj {
    match value {
        Value::Object(map) => map,
        _ => Obj::new(),
    }
}

fn normalized(route: &Value) -> Result<Option<Value>, String> {
    normalize_workflow_route(route, &Value::Object(Obj::new()), false)
}

impl AgentRouteSetter {
    async fn own_route(&self, id: &str) -> Result<Obj, String> {
        Ok(object(self.routes.own_route(id).await.map_err(text)?))
    }

    /// `chatRoute(id)`: the route a bot's chats run on, its own else Main's.
    async fn chat_route(&self, id: &str) -> Result<Option<Value>, String> {
        let own = self.own_route(id).await?;
        let route = if truthy(own.get("provider")) { Value::Object(own) } else { Value::Object(self.context.resolve_main()?) };
        normalized(&route)
    }

    /// `sameRoute(a, b)`: structural, after normalizing both.
    fn same_route(a: Option<&Value>, b: &Value) -> Result<bool, String> {
        let plain = |v: Option<&Value>| -> Result<Value, String> {
            Ok(match v {
                Some(v) => normalized(v)?.unwrap_or(Value::Null),
                None => Value::Null,
            })
        };
        Ok(plain(a)? == plain(Some(b))?)
    }

    /// `clearOverride(id)`: the agent inherits Main again.
    async fn clear_override(&self, id: &str) -> Result<Obj, String> {
        let before = self.chat_route(id).await?;
        self.routes.clear_route(id).await.map_err(text)?;
        let inherited = normalized(&Value::Object(self.context.resolve_main()?))?;
        if let Some(inherited) = &inherited {
            if !Self::same_route(before.as_ref(), inherited)? {
                self.publisher.publish(id, inherited).await;
            }
        }
        let base = inherited.as_ref().and_then(Value::as_object).cloned().unwrap_or_default();
        Ok(spread(&base, &[("inherited", Value::Bool(true))]))
    }

    pub async fn set_agent_route(&self, agent_id: &str, next: &Obj) -> Result<Value, String> {
        let id = agent_editor_id(agent_id);
        if id.is_empty() {
            return Err(format!("unknown agent \"{agent_id}\""));
        }
        if self.hidden.contains(&id) {
            return Err(format!("agent \"{id}\" is internal and has no configurable route"));
        }
        let id_value = Value::from(id.as_str());
        let mut requested = next.clone();
        let only_if_empty = requested.get("onlyIfEmpty") == Some(&Value::Bool(true));
        requested.shift_remove("onlyIfEmpty");
        let stored = self.own_route(&id).await?;
        let kept = |fresh: Obj| Value::Object(spread(&fresh, &[("id", id_value.clone()), ("skipped", Value::Bool(true))]));
        if only_if_empty && !clean(stored.get("provider")).is_empty() {
            return Ok(kept(self.own_route(&id).await?));
        }
        let mixy = self.routes.home(&id).await.map_err(text)? == RouteHome::Mixy;
        if mixy && requested.contains_key("disabled") {
            requested.shift_remove("disabled");
            if requested.is_empty() {
                return Ok(Value::Object(spread(&stored, &[("id", id_value)])));
            }
        }
        let keep_off = requested.get("disabled") == Some(&Value::Bool(true));
        let complete = !clean(requested.get("provider")).is_empty() && !clean(requested.get("model")).is_empty();
        if keep_off && !complete {
            self.routes.set_disabled(&id, true).await.map_err(text)?;
            if requested.contains_key("provider") && clean(requested.get("provider")).is_empty() {
                let cleared = self.clear_override(&id).await?;
                return Ok(Value::Object(spread(&cleared, &[("id", id_value), ("disabled", Value::Bool(true))])));
            }
            return Ok(Value::Object(spread(&stored, &[("id", id_value), ("disabled", Value::Bool(true))])));
        }
        if requested.get("disabled") == Some(&Value::Bool(false)) && requested.len() == 1 {
            self.routes.set_disabled(&id, false).await.map_err(text)?;
            return Ok(Value::Object(spread(
                &stored,
                &[("id", id_value), ("disabled", Value::Bool(false)), ("inherited", Value::Bool(!truthy(stored.get("provider"))))],
            )));
        }
        requested.shift_remove("disabled");
        let current: Obj = if truthy(stored.get("provider")) {
            stored.clone()
        } else {
            normalized(&Value::Object(self.context.resolve_main()?))?.map(object).unwrap_or_default()
        };
        if !requested.contains_key("provider") {
            if let Some(p) = current.get("provider") {
                requested.insert("provider".into(), p.clone());
            }
        }
        if !requested.contains_key("model") && clean(requested.get("provider")) == clean(current.get("provider")) {
            if let Some(m) = current.get("model") {
                requested.insert("model".into(), m.clone());
            }
        }
        if clean(requested.get("provider")).is_empty() {
            return Ok(Value::Object(self.clear_override(&id).await?));
        }
        if clean(requested.get("model")).is_empty() {
            return Err("agent route requires provider and model".into());
        }
        let explicit_fallbacks = requested.contains_key("fallbacks");
        let mut head = requested.clone();
        if !explicit_fallbacks {
            if let Some(f) = stored.get("fallbacks") {
                head.insert("fallbacks".into(), f.clone());
            }
        }
        let chain = route_chain(&Value::Object(head))?;
        validate_route_chain_providers(&chain, !explicit_fallbacks)?;
        let stored_chain = route_chain(&Value::Object(stored.clone()))?;
        let mut resolved: Vec<Value> = Vec::new();
        let mut used: HashSet<String> = HashSet::new();
        for entry in &chain {
            let inactive = !used.insert(canonical_route_provider(&clean(entry.get("provider"))));
            let previous = stored_chain
                .iter()
                .find(|c| c.get("provider") == entry.get("provider") && c.get("model") == entry.get("model"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            resolved.push(if inactive {
                entry.clone()
            } else {
                Value::Object(self.context.resolve_chain_entry(entry.as_object().unwrap_or(&Obj::new()), &previous).await?)
            });
        }
        let mut rest = resolved.into_iter();
        let mut with_fallbacks = rest.next().map(object).unwrap_or_default();
        with_fallbacks.insert("fallbacks".into(), Value::Array(rest.collect()));
        let route_to_save = normalized(&Value::Object(with_fallbacks))?
            .map(object)
            .ok_or_else(|| "agent route requires provider and model".to_owned())?;
        if only_if_empty && self.routes.home(&id).await.map_err(text)? == RouteHome::Config {
            self.config.reload_full_config().await.map_err(text)?;
        }
        if only_if_empty && !clean(self.own_route(&id).await?.get("provider")).is_empty() {
            return Ok(kept(self.own_route(&id).await?));
        }
        let stay_off = if only_if_empty { self.routes.is_disabled(&id) } else { keep_off };
        let before = self.chat_route(&id).await?;
        self.routes.save_route(&id, Value::Object(route_to_save.clone()), stay_off).await.map_err(text)?;
        let saved = Value::Object(route_to_save.clone());
        if !Self::same_route(before.as_ref(), &saved)? {
            self.publisher.publish(&id, &saved).await;
        }
        Ok(if stay_off { Value::Object(spread(&route_to_save, &[("id", id_value), ("disabled", Value::Bool(true))])) } else { saved })
    }
}
