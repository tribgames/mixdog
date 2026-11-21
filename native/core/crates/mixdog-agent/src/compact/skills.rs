//! Skill state restored at a fresh-context boundary, independently of the conversation summary.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use mixdog_core_api::domain::provider::{Content, ToolCall};
use mixdog_js::js_trim;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::estimate::MessageMeter;
use super::messages::call_arguments;
use crate::message::{AgentMessage, Source, ToolKind};
use crate::native_search::NativeDefinitions;
use crate::skill_update::{LoadedBody, latest_skill_bodies};

/// The current delivery after enablement and scope checks. Preview resolves the body and
/// linked tools but leaves `result` unset so existing native payloads are not rewritten.
pub struct CurrentSkill {
    pub body: String,
    pub tools: Vec<String>,
    pub result: Option<CurrentSkillResult>,
}

pub struct CurrentSkillResult {
    pub summary: String,
    pub native: Option<Value>,
}

#[async_trait]
pub trait CurrentSkills: Send + Sync {
    async fn resolve(&self, name: &str, preview: bool) -> Result<Option<CurrentSkill>, String>;

    /// Activate dependencies only when the host has adopted the restored body.
    async fn activate(&self, _name: &str, _body: &str) -> Result<(), String> {
        Ok(())
    }
}

const MAX_IDLE: u64 = 3;

fn runtime_row(source: &str, text: String, meta: Value) -> AgentMessage {
    let mut meta = meta.as_object().expect("skill metadata object").clone();
    meta.insert("source".into(), json!(source));
    meta.insert("synthetic".into(), json!(true));
    crate::message_row::message_of(&json!({"role": "user", "content": text, "meta": meta})).expect("runtime skill row")
}

pub(super) fn window_marker(span: usize) -> AgentMessage {
    runtime_row("compact-skill-window", "[mixdog-runtime] Compact boundary.".to_owned(), json!({"span": span}))
}

fn reload_line(name: &str, idle: u64) -> AgentMessage {
    runtime_row(
        "compact-skill-reload",
        format!(
            "[mixdog-runtime] Skill \"{name}\" was active earlier, but Compact did not keep its instructions. Reload it with the Skill tool before relying on them."
        ),
        json!({"skill": name, "idle": idle}),
    )
}

fn meta<'a>(row: &'a AgentMessage, field: &str) -> Option<&'a Value> {
    row.stored.as_ref()?.get("meta")?.get(field)
}

pub(super) fn window_start(conversation: &[AgentMessage]) -> usize {
    let Some(at) = conversation.iter().rposition(|m| m.source == Some(Source::CompactSkillWindow)) else { return 0 };
    let Some(span) = meta(&conversation[at], "span").and_then(Value::as_u64).and_then(|span| usize::try_from(span).ok()) else { return 0 };
    conversation[..at].iter().filter(|m| m.source != Some(Source::CompactSkillWindow) && !crate::project::is_summary_message(m)).count().saturating_add(span)
}

fn skill_name(call: &ToolCall) -> String {
    js_trim(call_arguments(&call.arguments).get("name").and_then(Value::as_str).unwrap_or_default()).to_owned()
}

fn native_references(message: &AgentMessage) -> impl Iterator<Item = &str> {
    message
        .message
        .native_tool_search
        .as_ref()
        .and_then(|native| native.get("toolReferences"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn is_loader(call: &ToolCall) -> bool {
    matches!(call.name.as_str(), "Skill" | "skill_view")
}

fn set_result(message: &mut AgentMessage, summary: String, native: Option<Value>) {
    message.message.content = Content::Text(summary);
    message.message.native_tool_search = native;
}

fn successful_load(message: &AgentMessage, legacy: bool) -> bool {
    message.message.native_tool_search.is_some() || {
        let text = message.text();
        text.starts_with("Loaded skill: ")
            || text.starts_with("Loaded built-in skill: ")
            || (legacy && !message.message.is_error && js_trim(&text).starts_with("<skill>"))
    }
}

struct Loader<'a> {
    owner: &'a AgentMessage,
    call: &'a ToolCall,
    result: &'a AgentMessage,
}

pub(super) struct SkillState<'a> {
    current: HashMap<String, Option<CurrentSkill>>,
    bodies: Vec<LoadedBody>,
    previous: Vec<(String, u64)>,
    loaders: HashMap<String, Vec<(usize, Loader<'a>)>>,
    last_use: HashMap<String, usize>,
}

impl<'a> SkillState<'a> {
    pub(super) async fn read(live: &'a [AgentMessage], resolver: Option<&dyn CurrentSkills>, window: usize, preview: bool) -> Result<Self, String> {
        let bodies = latest_skill_bodies(live);
        let loaded: HashSet<&str> = bodies.iter().map(|body| body.name.as_str()).collect();
        let mut previous: Vec<(String, u64)> = Vec::new();
        let mut calls = HashMap::new();
        let mut loaders: HashMap<String, Vec<(usize, Loader<'_>)>> = HashMap::new();
        for (index, message) in live.iter().enumerate() {
            if message.source == Some(Source::CompactSkillReload)
                && let Some(name) = meta(message, "skill").and_then(Value::as_str)
                && !loaded.contains(name)
            {
                previous.retain(|(existing, _)| existing != name);
                previous.push((name.to_owned(), meta(message, "idle").and_then(Value::as_u64).unwrap_or_default()));
            }
            for call in message.tool_calls().iter().filter(|call| is_loader(call)) {
                calls.insert(call.id.as_str(), (message, call));
            }
            if let Some((owner, call)) = message.tool_call_id().and_then(|id| calls.get(id).copied())
                && successful_load(message, call.name == "skill_view")
            {
                let name = skill_name(call);
                if !name.is_empty() {
                    loaders.entry(name).or_default().push((index, Loader { owner, call, result: message }));
                }
            }
        }
        let mut state = Self { current: HashMap::new(), bodies, previous, loaders, last_use: HashMap::new() };
        if let Some(resolver) = resolver {
            for name in state.bodies.iter().map(|b| &b.name).chain(state.previous.iter().map(|(name, _)| name)).chain(state.loaders.keys()) {
                if !state.current.contains_key(name) {
                    state.current.insert(name.clone(), resolver.resolve(name, preview).await?);
                }
            }
        }
        state.last_use = state.usage(live, window);
        Ok(state)
    }

    fn available(&self, name: &str) -> bool {
        !matches!(self.current.get(name), Some(None))
    }

    fn usage(&self, live: &[AgentMessage], window: usize) -> HashMap<String, usize> {
        let mut skills_of_tool: HashMap<&str, Vec<&str>> = HashMap::new();
        for name in self.bodies.iter().map(|b| b.name.as_str()).chain(self.previous.iter().map(|(name, _)| name.as_str())) {
            let skill = self.current.get(name).and_then(Option::as_ref);
            let declared = skill.into_iter().flat_map(|skill| skill.tools.iter().map(String::as_str));
            let current = skill
                .and_then(|skill| skill.result.as_ref())
                .and_then(|result| result.native.as_ref())
                .and_then(|native| native.get("toolReferences"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            let historical = self.loaders.get(name).into_iter().flatten().flat_map(|(_, loader)| native_references(loader.result));
            for tool in declared.chain(current).chain(historical) {
                skills_of_tool.entry(tool).or_default().push(name);
            }
        }
        let mut use_at = HashMap::new();
        for (at, message) in live.iter().enumerate().skip(window) {
            for call in message.tool_calls() {
                if is_loader(call) {
                    use_at.insert(skill_name(call), at);
                    continue;
                }
                let arguments = call_arguments(&call.arguments);
                let name = if call.name == "call_tool" { arguments.get("name").and_then(Value::as_str).unwrap_or_default() } else { call.name.as_str() };
                let mcp = name
                    .strip_prefix("functions.")
                    .unwrap_or(name)
                    .strip_prefix("mcp__")
                    .and_then(|name| name.split_once("__"))
                    .filter(|(server, tool)| !server.is_empty() && !tool.is_empty())
                    .map(|(server, _)| format!("mcp:{server}"));
                let matched =
                    skills_of_tool.get(name).into_iter().flatten().chain(mcp.as_deref().and_then(|server| skills_of_tool.get(server)).into_iter().flatten());
                for skill in matched {
                    use_at.insert((*skill).to_owned(), at);
                }
            }
        }
        for body in self.bodies.iter().filter(|body| body.index >= window) {
            let at = use_at.entry(body.name.clone()).or_default();
            *at = (*at).max(body.index);
        }
        use_at
    }

    /// Keep execution call/result pairing, but don't carry stale instructions, reload reminders,
    /// or native definitions from a skill whose current delivery has changed.
    pub(super) fn reconcile_tail(&self, tail: &mut Vec<AgentMessage>) {
        tail.retain(|m| {
            !matches!(m.source, Some(Source::CompactSkillReload | Source::CompactSkillWindow | Source::SkillUpdateNotice))
                && !crate::project::is_injected_skill_body(m)
        });
        let calls: HashMap<String, (String, bool)> = tail
            .iter()
            .flat_map(|m| m.tool_calls())
            .filter(|call| is_loader(call))
            .map(|call| (call.id.clone(), (skill_name(call), call.name == "skill_view")))
            .collect();
        let mut definitions = NativeDefinitions::default();
        for message in tail.iter_mut() {
            if let Some((name, legacy)) = message.tool_call_id().and_then(|id| calls.get(id))
                && successful_load(message, *legacy)
            {
                match self.current.get(name) {
                    Some(None) => set_result(
                        message,
                        format!(
                            "Skill \"{name}\" is no longer available in this session (switched off, removed, or outside this project's scope); its instructions and tools are not active."
                        ),
                        None,
                    ),
                    Some(Some(current)) => {
                        // Older viewers could return the instructions inline rather than a separate body.
                        let inline = *legacy && message.message.native_tool_search.is_none() && js_trim(&message.text()).starts_with("<skill>");
                        if let Some(result) = &current.result
                            && !inline
                        {
                            set_result(message, result.summary.clone(), result.native.clone());
                        }
                    }
                    None => {}
                }
            }
            message.message.native_tool_search = message.message.native_tool_search.take().and_then(|payload| definitions.take_new(payload));
        }
    }

    fn body_and_loader(&self, body: &LoadedBody, live: &[AgentMessage], retained: &HashSet<&str>) -> Vec<AgentMessage> {
        let name = &body.name;
        let skill = self.current.get(name).and_then(Option::as_ref);
        let loader = self.loaders.get(name).and_then(|entries| entries.iter().rev().find(|(at, _)| *at < body.index)).map(|(_, loader)| loader);
        let old_native = loader.and_then(|loader| loader.result.message.native_tool_search.as_ref());
        let current = skill.and_then(|skill| skill.result.as_ref());
        let native = current.map_or(old_native, |result| result.native.as_ref());
        let mut messages = Vec::new();
        if let Some(native) = native
            && !loader.is_some_and(|loader| retained.contains(loader.call.id.as_str()))
        {
            let call = loader.map_or_else(
                || {
                    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
                    ToolCall { id: format!("skill-restore-{}", &digest[..24]), name: "Skill".to_owned(), arguments: json!({"name": name}), native_type: None }
                },
                |loader| loader.call.clone(),
            );
            let mut owner = AgentMessage::assistant("", vec![call.clone()]);
            if let Some(loader) = loader {
                owner.message_id = loader.owner.message_id.clone();
            } else {
                owner.source = Some(Source::CompactSkillRestore);
            }
            let summary = current.map_or_else(|| native.get("summary").and_then(Value::as_str).unwrap_or_default(), |result| result.summary.as_str());
            let result = if let Some(loader) = loader
                && old_native == Some(native)
                && (current.is_none() || loader.result.text() == summary)
            {
                loader.result.clone()
            } else {
                let mut result = AgentMessage::tool_text(call.id, summary, ToolKind::Normal);
                result.message.native_tool_search = Some(native.clone());
                result.message_id = loader.and_then(|loader| loader.result.message_id.clone());
                result
            };
            messages.extend([owner, result]);
        }
        messages.push(match skill {
            Some(skill) if skill.body != body.body => AgentMessage::sourced(Source::Skill, skill.body.clone()),
            _ => live[body.index].clone(),
        });
        messages
    }

    fn carried_reminders(&self) -> Vec<(&str, u64)> {
        self.previous
            .iter()
            .filter(|(name, _)| self.available(name))
            .filter_map(|(name, idle)| {
                if self.last_use.contains_key(name) {
                    Some((name.as_str(), 0))
                } else if *idle < MAX_IDLE {
                    Some((name.as_str(), idle + 1))
                } else {
                    None
                }
            })
            .collect()
    }

    pub(super) fn restore(&self, live: &[AgentMessage], tail: &[AgentMessage], budget: u64, meter: &MessageMeter<'_>) -> Vec<AgentMessage> {
        let retained: HashSet<&str> = tail.iter().filter_map(AgentMessage::tool_call_id).collect();
        let bodies: Vec<_> = self.bodies.iter().filter(|body| self.available(&body.name)).collect();
        let mut reminders = self.carried_reminders();
        let reminder_cost = |name, idle| meter.message(&reload_line(name, idle));
        let mut reserved = reminders.iter().map(|(name, idle)| reminder_cost(name, *idle)).sum::<u64>()
            + bodies.iter().map(|body| reminder_cost(&body.name, u64::from(!self.last_use.contains_key(&body.name)))).sum::<u64>();
        let mut used: Vec<_> = bodies.iter().copied().filter(|body| self.last_use.contains_key(&body.name)).collect();
        used.sort_by_key(|body| std::cmp::Reverse(self.last_use[&body.name]));
        let mut restored = Vec::new();
        let mut tokens = 0;
        let mut kept = HashSet::new();
        let mut definitions = NativeDefinitions::default();
        for native in tail.iter().filter_map(|message| message.message.native_tool_search.as_ref()) {
            definitions.record(native);
        }
        for body in used {
            let mut messages = self.body_and_loader(body, live, &retained);
            let mut with_body = definitions.clone();
            if let Some(result) = messages.get_mut(1)
                && let Some(native) = result.message.native_tool_search.take()
            {
                result.message.native_tool_search = with_body.take_new(native);
                if result.message.native_tool_search.is_none() {
                    // No schema needs a synthetic call/result once the tail owns it.
                    messages.drain(..2);
                }
            }
            let cost = meter.compact_messages(&messages);
            let own = reminder_cost(&body.name, 0);
            if tokens + cost + reserved - own <= budget {
                tokens += cost;
                reserved -= own;
                kept.insert(body.name.as_str());
                definitions = with_body;
                restored.push(messages);
            }
        }
        reminders.extend(
            bodies
                .into_iter()
                .filter(|body| !kept.contains(body.name.as_str()))
                .map(|body| (body.name.as_str(), u64::from(!self.last_use.contains_key(&body.name)))),
        );
        let lines = reminders
            .into_iter()
            .rev()
            .filter_map(|(name, idle)| {
                let line = reload_line(name, idle);
                let cost = meter.message(&line);
                if tokens + cost > budget {
                    return None;
                }
                tokens += cost;
                Some(line)
            })
            .collect::<Vec<_>>();
        distinct_message_ids(restored, lines, tail)
    }
}

fn distinct_message_ids(restored: Vec<Vec<AgentMessage>>, lines: Vec<AgentMessage>, tail: &[AgentMessage]) -> Vec<AgentMessage> {
    let mut ids: HashSet<_> = tail.iter().filter_map(|m| m.message_id.clone()).collect();
    restored
        .into_iter()
        .rev()
        .flatten()
        .map(|mut message| {
            if message.message_id.as_ref().is_some_and(|id| !ids.insert(id.clone())) {
                message.message_id = None;
            }
            message
        })
        .chain(lines.into_iter().rev())
        .collect()
}
