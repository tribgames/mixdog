//! Mid-conversation reasoning-effort projection of a request.
//!
//! The run loop builds the provider requests, so it owns this projection: from
//! the effort snapshots the history rows carry in their message metadata
//! (`meta.effortConfiguration`, read by the host from `ItemRecord.body` through
//! the run's port into [`AgentMessage::effort`]) it derives the conversation's
//! initial effort and where the effort changed, maps them onto the route's wire
//! values with [`EffortProjection::from_session`], and hands the result to the
//! adapter with each attempt ([`EffortAdapter`], which sets `BuildInputs.effort`).

use std::sync::Arc;
use std::sync::LazyLock;

use async_trait::async_trait;
use std::collections::BTreeMap;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::JsonValue;
use regex::Regex;

use crate::message::AgentMessage;

const META_KEY: &str = "effortConfiguration";

/// Effort in wire values: `initial_effort` goes in the request's reasoning,
/// each entry of `updates` becomes a configuration update at that message
/// index. Same shape as the adapters' own projection; it moves into the
/// request options once the domain type exists.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EffortProjection {
    pub initial_effort: String,
    pub updates: BTreeMap<usize, String>,
}

impl EffortProjection {
    /// Maps the session's `initial` effort and `changes` (in transcript
    /// order, session names) onto the route's wire values. Consecutive changes
    /// that share a wire value collapse into none. `None` when any effort has
    /// no wire value on this route.
    pub fn from_session(
        initial: &str,
        changes: impl IntoIterator<Item = (usize, String)>,
        wire: &dyn Fn(&str) -> Option<String>,
    ) -> Option<Self> {
        let initial_effort = wire(initial)?;
        let mut current = initial_effort.clone();
        let mut updates = BTreeMap::new();
        for (index, effort) in changes {
            let value = wire(&effort)?;
            if value != current {
                current.clone_from(&value);
                updates.insert(index, value);
            }
        }
        Some(Self { initial_effort, updates })
    }
}

/// How the route takes mid-conversation effort updates.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EffortMode {
    /// `configuration_update` items on the Responses wire.
    Responses,
    /// Anthropic `output_config` control messages (the Anthropic adapter's own
    /// projection; the Responses projection is not built for it).
    Anthropic,
}

/// The effort a turn, or the step after a tool batch, ran at, as the message
/// that started it recorded it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EffortSnapshot {
    pub provider: String,
    /// Normalized model key (see [`model_key`]).
    pub model: String,
    pub mode: EffortMode,
    pub initial_effort: String,
    pub effort: String,
}

impl EffortSnapshot {
    /// Reads `meta.effortConfiguration` of a stored message body; `None` for a
    /// missing, malformed or unversioned value.
    pub fn from_body(body: &JsonValue) -> Option<Self> {
        Self::from_value(body.get("meta")?.get(META_KEY)?)
    }

    pub fn from_value(value: &JsonValue) -> Option<Self> {
        if value.get("version")?.as_u64()? != 1 {
            return None;
        }
        let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        let mode = match value.get("mode")?.as_str()? {
            "responses" => EffortMode::Responses,
            "anthropic" => EffortMode::Anthropic,
            _ => return None,
        };
        Some(Self {
            provider: text("provider")?,
            model: text("model")?,
            mode,
            initial_effort: text("initialEffort")?,
            effort: text("effort")?,
        })
    }
}

/// `claude-opus-5.5-20260101` → `claude-opus-5-5`: trimmed, lowercase, without
/// a trailing date, dots folded to dashes.
pub fn model_key(model: &str) -> String {
    static DASHED_DATE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"-\d{4}-\d{2}-\d{2}$").expect("static pattern"));
    static COMPACT_DATE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"-\d{8}$").expect("static pattern"));
    let lower = mixdog_js::js_trim(model).to_lowercase();
    let lower = DASHED_DATE.replace(&lower, "");
    let lower = COMPACT_DATE.replace(&lower, "");
    lower.replace('.', "-")
}

/// The route's wire value for a session effort name.
pub type WireEffort = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// What a route supplies for its projection.
#[derive(Clone)]
pub struct EffortRoute {
    pub provider: String,
    pub model: String,
    /// `effortConfigurationMode(provider, model, opts)`: `None` when the route
    /// takes no mid-conversation updates.
    pub mode: Option<EffortMode>,
    /// The efforts the route accepts in the session's own names.
    pub allowed: Vec<String>,
    /// The turn's own snapshot (`opts.effortConfiguration`), the seed when no
    /// row carries one.
    pub seed: Option<EffortSnapshot>,
    /// The route's wire value for a session effort name.
    pub wire: WireEffort,
}

impl EffortRoute {
    fn valid(&self, snapshot: &EffortSnapshot, mode: EffortMode) -> bool {
        snapshot.provider == self.provider
            && snapshot.model == model_key(&self.model)
            && snapshot.mode == mode
            && self.allowed.contains(&snapshot.initial_effort)
            && self.allowed.contains(&snapshot.effort)
    }

    /// The projection of `messages` for a Responses-wire request, or `None`
    /// when the route takes none or no valid snapshot seeds it. A user message
    /// carries a turn's effort; a tool result the effort of the step that
    /// follows its tool batch.
    pub fn project(&self, messages: &[AgentMessage]) -> Option<EffortProjection> {
        let mode = self.mode.filter(|m| *m == EffortMode::Responses)?;
        let marked: Vec<(usize, &EffortSnapshot)> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| matches!(m.role(), Role::User | Role::Tool))
            .filter_map(|(i, m)| m.effort.as_ref().map(|s| (i, s)))
            .filter(|(_, s)| self.valid(s, mode))
            .collect();
        let seed = marked
            .first()
            .map(|(_, s)| (*s).clone())
            .or_else(|| self.seed.clone())
            .filter(|s| self.valid(s, mode))?;
        let mut current = seed.initial_effort.clone();
        let mut changes: Vec<(usize, String)> = Vec::new();
        for (index, snapshot) in &marked {
            if snapshot.effort != current {
                current.clone_from(&snapshot.effort);
                changes.push((*index, snapshot.effort.clone()));
            }
        }
        if marked.is_empty()
            && seed.effort != current
            && let Some(next_user) = messages.iter().rposition(|m| m.role() == Role::User)
        {
            changes.push((next_user, seed.effort.clone()));
        }
        EffortProjection::from_session(&seed.initial_effort, changes, &*self.wire)
    }
}

/// An adapter that takes the projection with each attempt (the Responses
/// adapters set `BuildInputs.effort` from it). `attempt` of the plain
/// `ProviderAdapter` is `attempt_with(request, None)`.
#[async_trait]
pub trait EffortAdapter: Send + Sync {
    async fn attempt_with(
        &self,
        request: Arc<ModelRequest>,
        effort: Option<EffortProjection>,
    ) -> Result<Box<dyn ModelStream>, ProviderError>;
}

/// The route's projection inputs and the adapter that consumes them; replaced
/// together when the route changes.
#[derive(Clone)]
pub struct EffortWiring {
    pub route: EffortRoute,
    pub adapter: Arc<dyn EffortAdapter>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn route() -> EffortRoute {
        EffortRoute {
            provider: "openai".into(),
            model: "GPT-6.1-2026-01-01".into(),
            mode: Some(EffortMode::Responses),
            allowed: ["low", "medium", "high"].map(String::from).to_vec(),
            seed: None,
            wire: Arc::new(|e| Some(e.to_owned())),
        }
    }

    fn snap(initial: &str, effort: &str) -> EffortSnapshot {
        EffortSnapshot {
            provider: "openai".into(),
            model: "gpt-6-1".into(),
            mode: EffortMode::Responses,
            initial_effort: initial.into(),
            effort: effort.into(),
        }
    }

    fn marked(role: Role, snapshot: Option<EffortSnapshot>) -> AgentMessage {
        let mut m = match role {
            Role::Tool => AgentMessage::tool_text("c", "r", crate::message::ToolKind::Normal),
            _ => AgentMessage::user("u"),
        };
        m.effort = snapshot;
        m
    }

    #[test]
    fn changes_are_where_the_recorded_effort_differs_from_the_running_one() {
        let messages = vec![
            marked(Role::User, Some(snap("low", "low"))),
            AgentMessage::assistant("a", Vec::new()),
            marked(Role::User, Some(snap("low", "high"))),
            marked(Role::Tool, Some(snap("low", "high"))),
            marked(Role::User, Some(snap("low", "low"))),
        ];
        let projection = route().project(&messages).unwrap();
        assert_eq!(projection.initial_effort, "low");
        assert_eq!(
            projection.updates.into_iter().collect::<Vec<_>>(),
            [(2, "high".to_owned()), (4, "low".to_owned())]
        );
    }

    #[test]
    fn without_marked_rows_the_turns_snapshot_updates_the_next_user_message() {
        let mut r = route();
        r.seed = Some(snap("low", "medium"));
        let messages = vec![AgentMessage::user("old"), AgentMessage::assistant("a", Vec::new()), AgentMessage::user("new")];
        let projection = r.project(&messages).unwrap();
        assert_eq!(projection.updates.into_iter().collect::<Vec<_>>(), [(2, "medium".to_owned())]);
    }

    #[test]
    fn invalid_snapshots_other_routes_and_unwired_efforts_project_nothing() {
        let other = EffortSnapshot { provider: "anthropic".into(), ..snap("low", "low") };
        assert!(route().project(&[marked(Role::User, Some(other))]).is_none());
        let mut r = route();
        r.wire = Arc::new(|e| (e != "high").then(|| e.to_owned()));
        assert!(r.project(&[marked(Role::User, Some(snap("low", "high")))]).is_none());
        r.mode = Some(EffortMode::Anthropic);
        assert!(r.project(&[marked(Role::User, Some(snap("low", "low")))]).is_none());
    }

    #[test]
    fn snapshots_parse_from_a_stored_body() {
        let body = json!({"role": "user", "meta": {"effortConfiguration": {
            "version": 1, "provider": "openai", "model": "gpt-6-1", "mode": "responses",
            "initialEffort": "low", "effort": "high"}}});
        assert_eq!(EffortSnapshot::from_body(&body), Some(snap("low", "high")));
        assert_eq!(EffortSnapshot::from_body(&json!({"meta": {"effortConfiguration": {"version": 2}}})), None);
        assert_eq!(model_key("claude-opus-5.5-20260101"), "claude-opus-5-5");
    }
}
