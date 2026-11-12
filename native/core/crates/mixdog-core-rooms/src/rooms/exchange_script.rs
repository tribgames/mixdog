//! A scripted exchange for the replays of Node's room recordings (`record-agent-room-cases.mjs`
//! `exchange(spec)`): the spec's scripted turns and supervisor decisions are fed to
//! [`run_room_exchange`] and what it did comes back in the recording's shape. Test builds only.
//!
//! `spec.plan` answers a turn (`byTurn[n]`, else `byId[id]`, else `default`, else `"speech"`;
//! `mention[id]` makes `id`'s turn a speech addressing that peer); `spec.choose` decides each step
//! (a list by step, `null` or a missing element is no decision and `{throws}` a failed one;
//! `{throwsAlways}`, `{rotate}`, `{rotateTurns}`, `{byMustPick}` or `{constant}`);
//! `supersededAfterStep` makes a newer user message pending from that step on, `stopWhenSpoken`
//! sets the stop once that member is handed a turn.

use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use super::exchange::{
    Action, Answer, CapLimit, DecideInput, Decision, ExchangeHost, ExchangeParams, ExchangeResult, Outcome, Scene, Turn, TurnResult,
    UsageLimit, run_room_exchange,
};

fn scene_name(scene: Scene) -> &'static str {
    match scene {
        Scene::Casual => "casual",
        Scene::Work => "work",
    }
}

fn result_name(result: TurnResult) -> &'static str {
    match result {
        TurnResult::Speech => "speech",
        TurnResult::Pass => "pass",
        TurnResult::Stopped => "stopped",
        TurnResult::Superseded => "superseded",
        TurnResult::Unavailable => "unavailable",
    }
}

/// A decision as Node's `parseRoomDecision` / `decideRoomTurn` return it.
pub fn decision_json(decision: &Decision) -> Value {
    let mut out = Map::new();
    match &decision.action {
        Action::Speak { agent_id, instruction } => {
            out.insert("action".into(), json!("speak"));
            out.insert("agentId".into(), json!(agent_id));
            if let Some(scene) = decision.scene {
                out.insert("scene".into(), json!(scene_name(scene)));
            }
            if !instruction.is_empty() {
                out.insert("instruction".into(), json!(instruction));
            }
        }
        Action::Finish => {
            out.insert("action".into(), json!("finish"));
            if let Some(scene) = decision.scene {
                out.insert("scene".into(), json!(scene_name(scene)));
            }
        }
        Action::Unmanaged => {
            out.insert("action".into(), json!("unmanaged"));
        }
    }
    Value::Object(out)
}

/// A recorded decision object as the exchange takes it; `None` for one it cannot use.
fn decision_of(value: &Value) -> Option<Decision> {
    let scene = match value.get("scene").and_then(Value::as_str) {
        Some("casual") => Some(Scene::Casual),
        Some("work") => Some(Scene::Work),
        _ => None,
    };
    let action = match value.get("action").and_then(Value::as_str)? {
        "speak" => Action::Speak {
            agent_id: value.get("agentId").and_then(Value::as_str).unwrap_or_default().to_owned(),
            instruction: value.get("instruction").and_then(Value::as_str).unwrap_or_default().to_owned(),
        },
        "finish" => Action::Finish,
        "unmanaged" => Action::Unmanaged,
        _ => return None,
    };
    Some(Decision { action, scene })
}

fn usage_of(value: &Value) -> UsageLimit {
    let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    UsageLimit { kind: text("kind"), provider: text("provider"), model: text("model"), reset_at: value.get("resetAt").and_then(Value::as_f64).map(|at| at as i64) }
}

/// A usage-limit stop as Node's `roomUsageLimit` returns it.
pub fn usage_json(usage: &UsageLimit) -> Value {
    json!({ "kind": usage.kind, "provider": usage.provider, "model": usage.model, "resetAt": usage.reset_at })
}

/// A scripted reply: a result name, or `{ result, mention?, failed?, usage? }`.
fn answer_of(reply: &Value) -> Answer {
    let (result, object) = match reply {
        Value::String(result) => (result.as_str(), None),
        other => (other.get("result").and_then(Value::as_str).unwrap_or_default(), Some(other)),
    };
    let result = match result {
        "speech" => TurnResult::Speech,
        "pass" => TurnResult::Pass,
        "stopped" => TurnResult::Stopped,
        "superseded" => TurnResult::Superseded,
        "unavailable" => TurnResult::Unavailable,
        other => panic!("recording: unknown scripted turn result {other:?}"),
    };
    let field = |key: &str| object.and_then(|object| object.get(key));
    Answer {
        result,
        mention: field("mention").and_then(Value::as_str).map(str::to_owned),
        failed: field("failed") == Some(&Value::Bool(true)),
        usage: field("usage").filter(|usage| usage.is_object()).map(usage_of),
    }
}

struct Script<'a> {
    spec: &'a Value,
    turns: Mutex<Vec<Value>>,
    steps: Mutex<Vec<Value>>,
    pending: Mutex<bool>,
    stop: Mutex<bool>,
}

fn step_json(input: &DecideInput) -> Value {
    let turns: Vec<Value> = input
        .turns
        .iter()
        .map(|turn| {
            let mut out = json!({ "id": turn.id, "result": result_name(turn.result) });
            if turn.failed {
                out["failed"] = json!(true);
            }
            out
        })
        .collect();
    json!({
        "mustPick": input.must_pick,
        "turns": turns,
        "last": input.last,
        "mention": input.mention.clone().unwrap_or_default(),
        "remaining": { "messages": input.remaining.messages, "steps": input.remaining.steps },
    })
}

#[async_trait]
impl ExchangeHost for Script<'_> {
    async fn speak(&self, agent_id: &str, turn: &Turn) -> Answer {
        let count = {
            let mut turns = self.turns.lock().unwrap();
            turns.push(json!({
                "id": agent_id,
                "turn": { "addressed": turn.addressed, "instruction": turn.instruction, "mentionedBy": turn.mentioned_by, "scene": scene_name(turn.scene) },
            }));
            turns.len()
        };
        if self.spec.get("stopWhenSpoken").and_then(Value::as_str) == Some(agent_id) {
            *self.stop.lock().unwrap() = true;
        }
        let plan = self.spec.get("plan");
        let reply = plan
            .and_then(|plan| plan.get("byTurn"))
            .and_then(|by_turn| by_turn.get(count - 1))
            .or_else(|| plan.and_then(|plan| plan.get("byId")).and_then(|by_id| by_id.get(agent_id)))
            .or_else(|| plan.and_then(|plan| plan.get("default")))
            .cloned()
            .unwrap_or_else(|| json!("speech"));
        match self.spec.get("mention").and_then(|mention| mention.get(agent_id)) {
            Some(peer) => answer_of(&json!({ "result": "speech", "mention": peer })),
            None => answer_of(&reply),
        }
    }

    async fn decide(&self, input: &DecideInput) -> Option<Decision> {
        let n = {
            let mut steps = self.steps.lock().unwrap();
            steps.push(step_json(input));
            steps.len()
        };
        if self.spec.get("supersededAfterStep").and_then(Value::as_f64) == Some(n as f64) {
            *self.pending.lock().unwrap() = true;
        }
        let choose = self.spec.get("choose")?;
        if choose.get("throwsAlways").is_some() {
            return None;
        }
        if let Some(list) = choose.as_array() {
            let decision = list.get(n - 1)?;
            return if decision.get("throws").is_some() { None } else { decision_of(decision) };
        }
        if let Some(rotate) = choose.get("rotate").and_then(Value::as_array) {
            let id = rotate.iter().filter_map(Value::as_str).find(|id| *id != input.last)?;
            return Some(Decision { action: Action::Speak { agent_id: id.to_owned(), instruction: String::new() }, scene: None });
        }
        if let Some(rotate) = choose.get("rotateTurns").and_then(Value::as_array) {
            let id = rotate[input.turns.len() % rotate.len()].as_str()?;
            return Some(Decision { action: Action::Speak { agent_id: id.to_owned(), instruction: String::new() }, scene: None });
        }
        if let Some(by_must_pick) = choose.get("byMustPick") {
            return decision_of(by_must_pick.get(input.must_pick.to_string())?);
        }
        decision_of(choose.get("constant")?)
    }

    fn stopped(&self) -> bool {
        *self.stop.lock().unwrap()
    }

    fn superseded(&self) -> bool {
        *self.pending.lock().unwrap()
    }
}

fn result_json(result: &ExchangeResult) -> Value {
    let outcome = match result.outcome {
        Outcome::Done => "done",
        Outcome::Capped => "capped",
        Outcome::Stopped => "stopped",
        Outcome::Superseded => "superseded",
        Outcome::Limited => "limited",
        Outcome::Failed => "failed",
    };
    let mut out = Map::new();
    out.insert("outcome".into(), json!(outcome));
    if result.outcome == Outcome::Limited {
        out.insert("usage".into(), result.usage.as_ref().map_or(Value::Null, usage_json));
    }
    if let Some(limit) = result.limit {
        out.insert("limit".into(), json!(match limit {
            CapLimit::Messages => "messages",
            CapLimit::Rounds => "rounds",
        }));
    }
    if !result.remaining.is_empty() {
        out.insert("remaining".into(), json!(result.remaining));
    }
    out.insert("rounds".into(), json!(result.rounds));
    out.insert("steps".into(), json!(result.steps));
    out.insert("messages".into(), json!(result.messages));
    Value::Object(out)
}

/// The scripted exchange of `spec`: `{ result, spoken, turns, steps }` as the recorder lists them
/// after its `spec`.
pub async fn run_spec(spec: &Value) -> Value {
    let script = Script { spec, turns: Mutex::default(), steps: Mutex::default(), pending: Mutex::default(), stop: Mutex::default() };
    let ids = |key: &str| -> Vec<String> {
        spec.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    };
    let count = |key: &str, default: u32| spec.get(key).and_then(Value::as_f64).map_or(default, |n| n as u32);
    let params = ExchangeParams {
        members: ids("members"),
        to: ids("to"),
        max_rounds: count("maxRounds", 3),
        max_messages: count("maxMessages", 8),
        waiting: spec.get("waiting").and_then(Value::as_bool).unwrap_or(true),
        only: spec.get("only").and_then(Value::as_bool).unwrap_or(false),
        whole_room: spec.get("wholeRoom").and_then(Value::as_bool),
    };
    let result = run_room_exchange(&script, params).await;
    let turns = script.turns.into_inner().unwrap();
    let spoken: Vec<String> = turns
        .iter()
        .map(|taken| {
            let (id, turn) = (taken["id"].as_str().unwrap(), &taken["turn"]);
            let (mentioned_by, instruction) = (turn["mentionedBy"].as_str().unwrap(), turn["instruction"].as_str().unwrap());
            if !mentioned_by.is_empty() {
                format!("{id}<{mentioned_by}")
            } else if !instruction.is_empty() {
                format!("{id}:{instruction}")
            } else {
                id.to_owned()
            }
        })
        .collect();
    json!({ "result": result_json(&result), "spoken": spoken, "turns": turns, "steps": script.steps.into_inner().unwrap() })
}