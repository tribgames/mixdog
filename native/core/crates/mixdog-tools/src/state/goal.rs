//! `goal`: the model-facing front end of the durable objective. The Goal runtime (state,
//! settlement guards, continuation) lives with the session; this is argument validation, the
//! heartbeat and open-todo guards, and the reply rendering.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde::Serialize;
use serde_json::Value;

use super::todo::TodoStore;
use crate::orch::ports::CallerFacts;
use crate::orch::ports::HEARTBEAT_NO_HANDOFF;
use crate::orch::util::PortError;
use crate::orch::util::clean;
use crate::orch::util::compact;
use crate::orch::util::invalid;
use crate::orch::util::refused;
use crate::orch::util::spec_from_def;
use crate::orch::util::text;

pub const MAX_GOAL_TIME_LIMIT_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const ACTIONS: [&str; 4] = ["status", "create", "complete", "block"];
/// Fields of the retired task/revision schema a restored provider may still fill from a frozen
/// tool list; they carry nothing now and are ignored.
const RETIRED_FIELDS: [&str; 4] = ["tasks", "updates", "revision", "time_mode"];

fn action_fields(action: &str) -> &'static [&'static str] {
    match action {
        "create" => &["action", "objective", "time_limit_minutes"],
        "block" => &["action", "blocker"],
        _ => &["action"],
    }
}

/// The Goal as the runtime keeps it. `goal` is the stored record (id, status, timeUsedMs,
/// blocker?, objective, …); `remaining_ms` is the time left under the cap, if one was set.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct GoalSnapshot {
    pub goal: Option<Value>,
    pub remaining_ms: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum GoalSettlement {
    Complete,
    Block { blocker: String },
}

/// The Goal runtime of a session. Each call is atomic against the Goal's own state; a
/// settlement applies to the Goal this turn worked on, and one replaced meanwhile (or whose
/// objective changed since the turn last saw it) is refused with the runtime's wording.
#[async_trait]
pub trait GoalPort: Send + Sync {
    async fn status(&self, thread: &ThreadId) -> Result<GoalSnapshot, PortError>;
    async fn create(
        &self,
        thread: &ThreadId,
        objective: String,
        time_limit_ms: Option<u64>,
    ) -> Result<GoalSnapshot, PortError>;
    async fn settle(&self, thread: &ThreadId, settlement: GoalSettlement) -> Result<GoalSnapshot, PortError>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactGoal<'a> {
    id: &'a Value,
    status: &'a Value,
    time_used_ms: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocker: Option<&'a Value>,
}

#[derive(Serialize)]
struct Reply<G: Serialize> {
    goal: G,
    remaining_ms: Option<u64>,
}

/// `{goal, remaining_ms}`: the compact view for settlements, the full record for status and
/// create.
fn reply(snapshot: &GoalSnapshot, full: bool) -> String {
    let remaining_ms = snapshot.remaining_ms;
    let Some(goal) = &snapshot.goal else {
        return compact(&Reply { goal: Value::Null, remaining_ms });
    };
    if full {
        return compact(&Reply { goal, remaining_ms });
    }
    static NULL: Value = Value::Null;
    let view = CompactGoal {
        id: goal.get("id").unwrap_or(&NULL),
        status: goal.get("status").unwrap_or(&NULL),
        time_used_ms: goal.get("timeUsedMs").unwrap_or(&NULL),
        blocker: goal.get("blocker").filter(|b| !b.is_null() && b.as_str() != Some("")),
    };
    compact(&Reply { goal: view, remaining_ms })
}

/// The action of a call, or the existing refusal text.
fn validate(args: &Value) -> Result<String, String> {
    let object = args
        .as_object()
        .ok_or_else(|| "goal arguments must be an object".to_owned())?;
    let action = clean(object.get("action")).to_lowercase();
    if action.is_empty() {
        return Err("goal action is required".to_owned());
    }
    if !ACTIONS.contains(&action.as_str()) {
        return Err(format!("goal action must be one of: {}", ACTIONS.join(", ")));
    }
    let tool_fields = ["action", "objective", "time_limit_minutes", "blocker"];
    let extras: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|k| !tool_fields.contains(k) && !RETIRED_FIELDS.contains(k))
        .collect();
    if !extras.is_empty() {
        return Err(format!(
            "goal arguments contain unknown fields: {}. Allowed for {action}: {}",
            extras.join(", "),
            action_fields(&action).join(", ")
        ));
    }
    Ok(action)
}

/// A minutes field (`time_limit_minutes`) as a duration in ms; `None` when the call carries none.
fn minutes_ms(args: &Value, field: &str) -> Result<Option<u64>, String> {
    let max_minutes = MAX_GOAL_TIME_LIMIT_MS as f64 / 60_000.0;
    let minutes = match args.get(field) {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(n)) => n.as_f64(),
        Some(_) => None,
    };
    let minutes = minutes
        .filter(|m| m.is_finite() && (1.0..=max_minutes).contains(m))
        .ok_or_else(|| format!("goal {field} must be a number from 1 to {max_minutes} minutes"))?;
    Ok(Some((minutes * 60_000.0).round() as u64))
}

fn time_limit_ms(args: &Value) -> Result<Option<u64>, String> {
    minutes_ms(args, "time_limit_minutes")
}

pub struct GoalTool {
    spec: ToolSpec,
    goals: Arc<dyn GoalPort>,
    todos: Arc<dyn TodoStore>,
    facts: Arc<dyn CallerFacts>,
}

impl GoalTool {
    pub fn new(goals: Arc<dyn GoalPort>, todos: Arc<dyn TodoStore>, facts: Arc<dyn CallerFacts>) -> Self {
        Self {
            spec: spec_from_def(include_str!("defs/goal.json"), false, &[]),
            goals,
            todos,
            facts,
        }
    }
}

#[async_trait]
impl Tool for GoalTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let thread = &ctx.thread_id;
        let action = validate(&args).map_err(|m| invalid("action", m))?;
        // A Goal keeps working in its session across turns: a heartbeat's would run on unseen.
        if action == "create" && self.facts.is_heartbeat(thread).await {
            return Err(refused("heartbeat", format!("goal: {HEARTBEAT_NO_HANDOFF}")));
        }
        let snapshot = match action.as_str() {
            "status" => reply(&self.goals.status(thread).await?, true),
            "create" => {
                let limit = time_limit_ms(&args).map_err(|m| invalid("time_limit_minutes", m))?;
                let objective = args.get("objective").and_then(Value::as_str).unwrap_or_default().to_owned();
                reply(&self.goals.create(thread, objective, limit).await?, true)
            }
            "block" => {
                let blocker = clean(args.get("blocker"));
                reply(&self.goals.settle(thread, GoalSettlement::Block { blocker }).await?, false)
            }
            _ => {
                // A completion claim with steps still open in the session's own list has not
                // finished the work it recorded.
                let list = self.todos.read(thread).await;
                let open = list.open_items();
                if !open.is_empty() {
                    let named: Vec<&str> = open.iter().map(|t| t.content.as_str()).collect();
                    return Err(refused(
                        "open-todo",
                        format!(
                            "goal: cannot complete with {} open todo item(s) ({}); finish them, or drop or block each with its reason",
                            open.len(),
                            named.join("; ")
                        ),
                    ));
                }
                reply(&self.goals.settle(thread, GoalSettlement::Complete).await?, false)
            }
        };
        text(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn settlement_view_is_compact_and_ordered() {
        let snapshot = GoalSnapshot {
            goal: Some(json!({"id":"g1","status":"blocked","timeUsedMs":5,"blocker":"stuck","objective":"x"})),
            remaining_ms: Some(10),
        };
        assert_eq!(
            reply(&snapshot, false),
            r#"{"goal":{"id":"g1","status":"blocked","timeUsedMs":5,"blocker":"stuck"},"remaining_ms":10}"#
        );
        assert_eq!(reply(&GoalSnapshot::default(), true), r#"{"goal":null,"remaining_ms":null}"#);
    }

    #[test]
    fn unknown_fields_are_refused_but_retired_ones_ignored() {
        assert_eq!(
            validate(&json!({"action":"status","bogus":1})).unwrap_err(),
            "goal arguments contain unknown fields: bogus. Allowed for status: action"
        );
        assert_eq!(validate(&json!({"action":"Status","tasks":[]})), Ok("status".to_owned()));
        assert_eq!(validate(&json!({})).unwrap_err(), "goal action is required");
        assert_eq!(
            validate(&json!({"action":"stop"})).unwrap_err(),
            "goal action must be one of: status, create, complete, block"
        );
        // Node has no `extend` action (`goal-tool-defs.mjs`): it is an unknown action, and `extend_minutes` an unknown field.
        assert_eq!(validate(&json!({"action":"extend","extend_minutes":5})).unwrap_err(), "goal action must be one of: status, create, complete, block");
        assert_eq!(
            validate(&json!({"action":"create","extend_minutes":5})).unwrap_err(),
            "goal arguments contain unknown fields: extend_minutes. Allowed for create: action, objective, time_limit_minutes"
        );
    }

    #[test]
    fn the_time_limit_accepts_whole_numbers_of_minutes_in_range_and_coerces_nothing() {
        for ok in [json!(1), json!(2.5), json!(10080)] {
            let want = (ok.as_f64().unwrap() * 60_000.0).round() as u64;
            assert_eq!(time_limit_ms(&json!({"time_limit_minutes": ok})), Ok(Some(want)), "create {ok}");
        }
        for bad in [json!(0.5), json!(0), json!(10081), json!(-5), json!(true), json!([2]), json!("5"), json!("")] {
            assert_eq!(
                time_limit_ms(&json!({"time_limit_minutes": bad})).unwrap_err(),
                "goal time_limit_minutes must be a number from 1 to 10080 minutes",
                "create {bad}"
            );
        }
        assert_eq!(time_limit_ms(&json!({"time_limit_minutes": null})), Ok(None));
    }

    /// The tool definition is Node's own (`goal-tool-defs.mjs`): four actions, no `extend`.
    #[test]
    fn the_definition_has_nodes_four_actions() {
        let def: Value = serde_json::from_str(include_str!("defs/goal.json")).expect("goal.json");
        assert!(!def["description"].as_str().expect("description").contains("extend"));
        let props = &def["inputSchema"]["properties"];
        assert_eq!(props["action"]["enum"], json!(["status", "create", "complete", "block"]));
        assert!(props.get("extend_minutes").is_none());
    }

    #[test]
    fn time_limit_converts_minutes_and_rejects_nonpositive() {
        assert_eq!(time_limit_ms(&json!({"time_limit_minutes": 2})), Ok(Some(120_000)));
        assert_eq!(time_limit_ms(&json!({})), Ok(None));
        assert!(time_limit_ms(&json!({"time_limit_minutes": 0})).is_err());
        assert_eq!(
            time_limit_ms(&json!({"time_limit_minutes": 20000})).unwrap_err(),
            "goal time_limit_minutes must be a number from 1 to 10080 minutes"
        );
    }
}
