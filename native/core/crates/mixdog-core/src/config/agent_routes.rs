//! Where an agent's route is stored, and whether the agent is off (Node's `saveRoute`,
//! `ownRoute`, `clearOverride`'s storage half and `saveDisabled` in `agent-route.mjs`, over
//! `agent-store.mjs` and `agent-route-config.mjs`).
//!
//! Three homes, one rule each:
//! - Mixy (runtime id `lead`) keeps its own route in `bots/mixy/agent.json` (`route`); the Lead's
//!   route is never touched.
//! - A store bot keeps its route in `bots/<id>/agent.json`; its off state stays in the config.
//! - Every other agent keeps its route in `agent.agents[<id>]` of the config.
//!
//! The route itself arrives normalised and resolved (provider, model, effort, fallbacks…): choosing
//! a model, validating a chain and the id check belong to the route service, which calls this.
//! Every file job runs on the lanes of the `Config`; nothing here blocks a runtime thread.

use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use serde_json::Map;
use serde_json::Value;

use super::Config;
use super::ConfigError;
use super::on_lane;

const BOTS_DIR: &str = "bots";
const MIGRATION_MANIFEST: &str = "migration.json";
const MIGRATION_VERSION: i64 = 1;
const MIXY_BOT_ID: &str = "mixy";
/// Mixy's runtime id (agent-home.mjs `MIXY_AGENT_ID`).
pub const MIXY_RUNTIME_ID: &str = "lead";

/// Where an agent's route lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteHome {
    Mixy,
    StoreBot,
    Config,
}

#[derive(Clone)]
pub struct AgentRoutes {
    config: Config,
    /// The data directory holding `bots/`; empty when the host has none (every agent then lives
    /// in the config, Mixy included).
    data_dir: PathBuf,
}

impl AgentRoutes {
    pub fn new(config: Config, data_dir: impl Into<PathBuf>) -> Self {
        Self { config, data_dir: data_dir.into() }
    }

    /// Which store holds `id`'s route (`isMixy`, `isStoreBot`).
    pub async fn home(&self, id: &str) -> Result<RouteHome, ConfigError> {
        if id == MIXY_RUNTIME_ID && !self.data_dir.as_os_str().is_empty() {
            return Ok(RouteHome::Mixy);
        }
        let (dir, id) = (self.data_dir.clone(), id.to_owned());
        if on_lane(self.config.lanes.read, move |lane| is_store_bot(lane, &dir, &id)).await? {
            Ok(RouteHome::StoreBot)
        } else {
            Ok(RouteHome::Config)
        }
    }

    /// The route the agent saved of its own, `{}` when none (`ownRoute`). Always read from the
    /// disk and the live config, so a change is computed from what is stored now.
    pub async fn own_route(&self, id: &str) -> Result<Value, ConfigError> {
        let route = match self.home(id).await? {
            RouteHome::Mixy => self.read_bot_route(MIXY_BOT_ID).await?,
            RouteHome::StoreBot => self.read_bot_route(id).await?,
            RouteHome::Config => self
                .config
                .agent()
                .get("agents")
                .and_then(|agents| agents.get(id))
                .filter(|route| is_complete(route))
                .cloned(),
        };
        Ok(route.unwrap_or_else(|| Value::Object(Map::new())))
    }

    /// Whether the agent is switched off (`isAgentDisabled`).
    pub fn is_disabled(&self, id: &str) -> bool {
        disabled_ids(&self.config.agent()).contains(&agent_id_key(id))
    }

    /// Switches the agent on or off, keeping its stored model (`saveDisabled`).
    pub async fn set_disabled(&self, id: &str, disabled: bool) -> Result<(), ConfigError> {
        let id = agent_id_key(id);
        self.config
            .update_agent(move |agent| {
                with_disabled(agent, &id, disabled);
                canonicalize(agent);
                Ok(())
            })
            .await
            .map(|_| ())
    }

    /// Stores `route` for the agent (`saveRoute`). `keep_off` is the off state it ends in; Mixy is
    /// never off, so its flag is not touched.
    pub async fn save_route(&self, id: &str, route: Value, keep_off: bool) -> Result<(), ConfigError> {
        match self.home(id).await? {
            RouteHome::Mixy => self.write_bot_route(MIXY_BOT_ID, Some(route)).await,
            RouteHome::StoreBot => {
                self.write_bot_route(id, Some(route)).await?;
                self.set_disabled(id, keep_off).await
            }
            RouteHome::Config => {
                let (key, id) = (agent_id_key(id), id.to_owned());
                self.config
                    .update_agent(move |agent| {
                        with_disabled(agent, &key, keep_off);
                        let agents = agent.entry("agents").or_insert_with(|| Value::Object(Map::new()));
                        if let Value::Object(agents) = agents {
                            agents.insert(id, route);
                        } else {
                            *agents = Value::Object(Map::from_iter([(id, route)]));
                        }
                        canonicalize(agent);
                        Ok(())
                    })
                    .await
                    .map(|_| ())
            }
        }
    }

    /// Drops the agent's own route so it follows Main again (the storage half of
    /// `clearOverride`). The config is only rewritten when the agent had an override.
    pub async fn clear_route(&self, id: &str) -> Result<(), ConfigError> {
        match self.home(id).await? {
            RouteHome::Mixy => self.write_bot_route(MIXY_BOT_ID, None).await,
            RouteHome::StoreBot => self.write_bot_route(id, None).await,
            RouteHome::Config => {
                let id = id.to_owned();
                self.config
                    .update_agent(move |agent| {
                        let had = agent
                            .get_mut("agents")
                            .and_then(Value::as_object_mut)
                            .is_some_and(|agents| agents.shift_remove(&id).is_some());
                        if had {
                            canonicalize(agent);
                        }
                        Ok(())
                    })
                    .await
                    .map(|_| ())
            }
        }
    }

    async fn read_bot_route(&self, bot: &str) -> Result<Option<Value>, ConfigError> {
        let file = self.data_dir.join(BOTS_DIR).join(bot).join("agent.json");
        let manifest = on_lane(self.config.lanes.read, move |lane| read_json(lane, &file)).await?;
        Ok(manifest.and_then(|m| m.get("route").cloned()).filter(is_complete))
    }

    /// Stores (or with `None` removes) the route in the bot's `agent.json`; every other key stays.
    async fn write_bot_route(&self, bot: &str, route: Option<Value>) -> Result<(), ConfigError> {
        let file = self.data_dir.join(BOTS_DIR).join(bot).join("agent.json");
        let read_file = file.clone();
        let manifest = on_lane(self.config.lanes.read, move |lane| read_json(lane, &read_file)).await?;
        let mut manifest = manifest.unwrap_or_default();
        match route {
            Some(route) => {
                manifest.insert("route".into(), route);
            }
            None => {
                manifest.shift_remove("route");
            }
        }
        on_lane(self.config.lanes.write, move |lane| write_json(lane, &file, &manifest)).await?
    }
}

fn is_complete(route: &Value) -> bool {
    let text = |key: &str| {
        route.get(key).and_then(Value::as_str).is_some_and(|s| !mixdog_js::js_trim(s).is_empty())
    };
    route.is_object() && text("provider") && text("model")
}

/// `agentIdKey`: trimmed, lower-cased, runs of whitespace and `_` become `-`.
fn agent_id_key(value: &str) -> String {
    let mut out = String::new();
    let mut run = false;
    for ch in mixdog_js::js_trim(value).to_lowercase().chars() {
        if ch == '_' || mixdog_js::is_js_space(ch) {
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

/// `disabledAgentIds`: the sorted, de-duplicated, key-normalised list.
fn disabled_ids(agent: &Map<String, Value>) -> Vec<String> {
    id_list(agent.get("disabledAgents"))
}

/// `agentIdList`.
pub(super) fn id_list(raw: Option<&Value>) -> Vec<String> {
    let mut ids: Vec<String> = raw
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|v| agent_id_key(&js_string(v))).filter(|id| !id.is_empty()).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids
}

/// `String(value)` for the scalar shapes a stored id can have.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// `withAgentDisabled`.
fn with_disabled(agent: &mut Map<String, Value>, key: &str, disabled: bool) {
    if key.is_empty() {
        return;
    }
    let mut ids = disabled_ids(agent);
    ids.retain(|id| id != key);
    if disabled {
        ids.push(key.to_owned());
        ids.sort();
    }
    if ids.is_empty() {
        agent.shift_remove("disabledAgents");
    } else {
        agent.insert("disabledAgents".into(), Value::from(ids));
    }
}

/// `canonicalizeAgentRouteStorage` on the agent config: only complete routes survive in
/// `agents`, `agents.maintenance` / `maintenance.memory` / `workflowRoutes` and the generated
/// workflow presets are scrubbed, and the disabled list is normalised.
pub(super) fn canonicalize(agent: &mut Map<String, Value>) {
    agent.shift_remove("workflowRoutes");
    let agents: Map<String, Value> = agent
        .get("agents")
        .and_then(Value::as_object)
        .map(|agents| {
            agents
                .iter()
                .filter(|(id, route)| id.as_str() != "maintenance" && is_complete(route))
                .map(|(id, route)| (id.clone(), route.clone()))
                .collect()
        })
        .unwrap_or_default();
    agent.insert("agents".into(), Value::Object(agents));
    let mut maintenance = agent.get("maintenance").and_then(Value::as_object).cloned().unwrap_or_default();
    maintenance.shift_remove("memory");
    agent.insert("maintenance".into(), Value::Object(maintenance));
    let default = agent.get("default").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or("").to_owned();
    let presets: Vec<Value> = agent
        .get("presets")
        .and_then(Value::as_array)
        .map(|presets| presets.iter().filter(|p| !redundant_preset(p, &default)).cloned().collect())
        .unwrap_or_default();
    agent.insert("presets".into(), Value::Array(presets));
    let disabled = disabled_ids(agent);
    if disabled.is_empty() {
        agent.shift_remove("disabledAgents");
    } else {
        agent.insert("disabledAgents".into(), Value::from(disabled));
    }
}

fn redundant_preset(preset: &Value, default: &str) -> bool {
    let id = preset.get("id").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or("");
    !id.is_empty()
        && id != default
        && (id == "workflow-agent" || id == "workflow-memory" || id.starts_with("workflow-agent-"))
}

/// `isStoreBot`: the split finished (`bots/migration.json` at version 1) and the bot has its
/// folder or was copied by the split. Mixy's own folder is no ordinary bot.
#[allow(clippy::disallowed_methods, reason = "an io-interactive job body: the proof says it runs there")]
fn is_store_bot(lane: &InLane<InteractiveIo>, data_dir: &Path, id: &str) -> bool {
    if data_dir.as_os_str().is_empty() || id.is_empty() || id == MIXY_BOT_ID || id.starts_with('.') {
        return false;
    }
    let Some(manifest) = read_json(lane, &data_dir.join(BOTS_DIR).join(MIGRATION_MANIFEST)) else {
        return false;
    };
    if manifest.get("version").and_then(Value::as_i64) != Some(MIGRATION_VERSION) {
        return false;
    }
    data_dir.join(BOTS_DIR).join(id).exists()
        || manifest.get("bots").and_then(Value::as_array).is_some_and(|bots| bots.iter().any(|b| b.as_str() == Some(id)))
}

/// A JSON object file; a missing or damaged one falls back to its last good copy (`.bak`, left
/// by the previous write) and otherwise reads as absent.
#[allow(clippy::disallowed_methods, reason = "an io-interactive job body: the proof says it runs there")]
fn read_json(_lane: &InLane<InteractiveIo>, file: &Path) -> Option<Map<String, Value>> {
    let parse = |path: &Path| match serde_json::from_slice(&std::fs::read(path).ok()?) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    };
    parse(file).or_else(|| parse(&backup_of(file)))
}

fn backup_of(file: &Path) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    file.with_file_name(name)
}

/// Writes the file whole through a synced sibling; the previous content stays as `.bak`.
#[allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "an io-durability job body: the proof says it runs there"
)]
fn write_json(_lane: &InLane<DurabilityIo>, file: &Path, value: &Map<String, Value>) -> Result<(), ConfigError> {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| ConfigError::Parse(e.to_string()))?;
    bytes.push(b'\n');
    if file.exists() {
        std::fs::copy(file, backup_of(file))?;
    }
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = file.with_file_name(name);
    let written = (|| {
        let mut handle = std::fs::File::create(&tmp)?;
        handle.write_all(&bytes)?;
        handle.sync_all()?;
        std::fs::rename(&tmp, file)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(written?)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
