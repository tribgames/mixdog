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
const MAX_TOOL_MINUTES: f64 = 10_080.0;
const ACTIONS: [&str; 5] = ["status", "create", "complete", "block", "extend"];
/// Fields of the retired task/revision schema a restored provider may still fill from a frozen
/// tool list; they carry nothing now and are ignored.
const RETIRED_FIELDS: [&str; 4] = ["tasks", "updates", "revision", "time_mode"];

fn action_fields(action: &str) -> &'static [&'static str] {
    match action {
        "create" => &["action", "objective", "time_limit_minutes"],
        "block" => &["action", "blocker"],
        "extend" => &["action", "extend_minutes"],
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
    /// Adds `added_ms` to the time cap of an active or paused Goal that has one.
    async fn extend(&self, thread: &ThreadId, added_ms: u64) -> Result<GoalSnapshot, PortError>;
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
    let tool_fields = ["action", "objective", "time_limit_minutes", "blocker", "extend_minutes"];
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

/// `toolMinutesMs` (`goal-tool-exec.mjs`): a minutes field as validated ms. A JSON number from 1 to 10080, nothing
/// coerced; then `parseGoalDuration` of the ms (`Math.round`, at most 7 days by the range).
fn minutes_ms(value: &Value, field: &str) -> Result<u64, String> {
    let minutes = match value {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if !minutes.is_finite() || !(1.0..=MAX_TOOL_MINUTES).contains(&minutes) {
        return Err(format!("goal {field} must be a number from 1 to {MAX_TOOL_MINUTES} minutes"));
    }
    Ok((minutes * 60_000.0 + 0.5).floor() as u64)
}

/// `toolTimeLimitMs`: the create budget; `None` when the call carries none (absent or null).
fn time_limit_ms(args: &Value) -> Result<Option<u64>, String> {
    match args.get("time_limit_minutes") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => minutes_ms(value, "time_limit_minutes").map(Some),
    }
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
            // The user's explicit ask for more time (the description restricts it to that).
            "extend" => {
                let added = minutes_ms(args.get("extend_minutes").unwrap_or(&Value::Null), "extend_minutes")
                    .map_err(|m| invalid("extend_minutes", m))?;
                reply(&self.goals.extend(thread, added).await?, true)
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
            "goal action must be one of: status, create, complete, block, extend"
        );
        // `extend_minutes` is a tool field (`TOOL_FIELDS`), so it is no unknown field on another action either.
        assert_eq!(validate(&json!({"action":"extend","extend_minutes":5})), Ok("extend".to_owned()));
        assert_eq!(validate(&json!({"action":"create","extend_minutes":5})), Ok("create".to_owned()));
        assert_eq!(
            validate(&json!({"action":"extend","bogus":1})).unwrap_err(),
            "goal arguments contain unknown fields: bogus. Allowed for extend: action, extend_minutes"
        );
    }

    /// Node's own `executeGoalTool` create over every case of the recorder (`record-goal-time-limit.mjs`): strings,
    /// booleans and out-of-range numbers are refused, nothing is coerced.
    #[test]
    fn the_time_limit_equals_nodes_for_every_recorded_case() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/goal-time-limit/golden.json")).expect("golden");
        let cases = golden["cases"].as_array().expect("cases");
        assert!(cases.iter().any(|c| c["error"] == "goal time_limit_minutes must be a number from 1 to 10080 minutes" && c["args"]["time_limit_minutes"].is_string()));
        for case in cases {
            let got = time_limit_ms(&case["args"]);
            match case.get("error") {
                Some(error) => assert_eq!(got, Err(error.as_str().expect("error").to_owned()), "{}", case["args"]),
                None => assert_eq!(got.map(|ms| ms.map(|ms| json!(ms))), Ok(case.get("timeLimitMs").cloned()), "{}", case["args"]),
            }
        }
    }

    #[test]
    fn minutes_are_a_json_number_from_1_to_10080_and_nothing_is_coerced() {
        for (ok, want) in [(json!(1), 60_000), (json!(2.5), 150_000), (json!(10080), 604_800_000), (json!(1.00001), 60_001)] {
            assert_eq!(time_limit_ms(&json!({"time_limit_minutes": ok})), Ok(Some(want)), "create {ok}");
            assert_eq!(minutes_ms(&ok, "extend_minutes"), Ok(want), "extend {ok}");
        }
        for bad in [json!(0), json!(0.5), json!(-5), json!(10080.4), json!(10081), json!("5"), json!(""), json!(true), json!([2]), json!({})] {
            assert_eq!(
                time_limit_ms(&json!({"time_limit_minutes": bad})).unwrap_err(),
                "goal time_limit_minutes must be a number from 1 to 10080 minutes",
                "create {bad}"
            );
        }
        assert_eq!(minutes_ms(&Value::Null, "extend_minutes").unwrap_err(), "goal extend_minutes must be a number from 1 to 10080 minutes");
        assert_eq!(time_limit_ms(&json!({"time_limit_minutes": null})), Ok(None));
        assert_eq!(time_limit_ms(&json!({})), Ok(None));
    }

    /// The tool definition is Node's own (`goal-tool-defs.mjs`): five actions, `extend` with its minutes.
    #[test]
    fn the_definition_has_nodes_five_actions() {
        let def: Value = serde_json::from_str(include_str!("defs/goal.json")).expect("goal.json");
        assert!(def["description"].as_str().expect("description").contains("extend adds minutes"));
        let props = &def["inputSchema"]["properties"];
        assert_eq!(props["action"]["enum"], json!(ACTIONS));
        assert_eq!(props["extend_minutes"]["maximum"], json!(10080));
    }
}
