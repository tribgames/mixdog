//! A member's turn against `fixtures/room-member-turn/golden.json`, recorded from the real desktop
//! `agent-room-turn.ts` driven with a scripted host: every call the host took, in order, how each
//! covered call ended, and the state left behind.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use super::{MemberHost, PersistFuture, SubmitOptions, combined_call, speak_in_room};
use crate::rooms::calls::{CallFollow, Request, RoomCall, Run, Settled};
use crate::rooms::exchange::{Answer, Scene, Turn, TurnResult};
use crate::rooms::turn_host::{Failure, MemberLabel, RoomRecord, RoomTurnHost, TurnState};
use crate::rooms::turn_prompt::RoomPrompt;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/room-member-turn/golden.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

type Log = Arc<Mutex<Vec<Value>>>;

/// The recorder's world: a scripted host over one room; hooks change the exchange at a named call.
struct World {
    script: Value,
    log: Log,
    counts: Mutex<HashMap<String, u64>>,
    clock: AtomicU64,
    seq: AtomicU64,
    reads: AtomicU64,
    room: Arc<Mutex<RoomRecord>>,
    state: Arc<TurnState>,
}

impl World {
    fn push(&self, entry: Value) {
        self.log.lock().unwrap().push(entry);
    }

    fn count(&self, name: &str) -> u64 {
        *self.counts.lock().unwrap().get(name).unwrap_or(&1)
    }

    fn fire(&self, name: &str) {
        let count = {
            let mut counts = self.counts.lock().unwrap();
            let count = counts.entry(name.to_owned()).or_insert(0);
            *count += 1;
            *count
        };
        for hook in self.script["hooks"].as_array().into_iter().flatten() {
            if hook["on"] != name || hook.get("n").and_then(Value::as_u64).unwrap_or(1) != count {
                continue;
            }
            match hook["do"].as_str().unwrap() {
                "stop" => self.state.run.set_stopped(),
                "pending" => *self.state.run.pending() = Some(Request::default()),
                "remove" => self.room.lock().unwrap().members.retain(|id| id != "bench"),
                other => panic!("unknown hook {other}"),
            }
        }
    }

    fn fails(&self, key: &str) -> Result<(), String> {
        match self.script.get(key).and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        }
    }
}

fn answered_default() -> Value {
    json!({ "busy": false, "items": [
        { "kind": "user", "id": "u", "at": 1 },
        { "kind": "assistant", "id": "a", "text": "Hello there." },
        { "kind": "turndone", "id": 9, "at": 2000, "status": "done", "finalAssistantId": "a" },
    ] })
}

#[async_trait]
impl RoomTurnHost for World {
    fn room_id(&self) -> &str {
        "room01"
    }
    fn poll_ms(&self) -> u64 {
        25
    }
    fn now(&self) -> i64 {
        i64::try_from(self.clock.fetch_add(1, Ordering::SeqCst) + 1).unwrap()
    }
    fn new_id(&self) -> String {
        format!("n{}", self.seq.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn republish(&self) {
        self.push(json!(["republish"]));
    }
    fn log(&self, line: &str) {
        self.push(json!(["log", line]));
    }
    async fn sleep(&self, ms: u64) {
        self.push(json!(["sleep", ms]));
    }
    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        self.push(json!(["post", rows]));
        self.fails("postFails")
    }
    async fn read_snapshot(&self, session_id: &str) -> Result<Value, String> {
        self.push(json!(["readSnapshot", session_id]));
        let list = self.script.get("snapshots").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![answered_default()]);
        let read = usize::try_from(self.reads.fetch_add(1, Ordering::SeqCst)).unwrap();
        let next = list[read.min(list.len() - 1)].clone();
        self.fire("readSnapshot");
        match next.get("throw").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(next),
        }
    }
}

#[async_trait]
impl MemberHost for World {
    fn room(&self) -> Result<Arc<Mutex<RoomRecord>>, String> {
        self.fails("roomThrows")?;
        Ok(self.room.clone())
    }
    async fn rows(&self) -> Result<Vec<Value>, String> {
        self.push(json!(["rows"]));
        self.fire("rows");
        Ok(self.script.get("rows").and_then(Value::as_array).cloned().unwrap_or_default())
    }
    async fn member_session(&self, member: &MemberLabel) -> Result<String, String> {
        self.push(json!(["memberSession", member.id]));
        self.fire("memberSession");
        self.fails("sessionThrows")?;
        Ok(self.script.get("session").and_then(Value::as_str).unwrap_or("sess1").to_owned())
    }
    async fn switched_off(&self, agent_id: &str) -> Result<bool, String> {
        self.push(json!(["switchedOff", agent_id]));
        self.fire("switchedOff");
        let list = self.script.get("switchedOff").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!(false)]);
        let value = &list[usize::try_from(self.count("switchedOff") - 1).unwrap().min(list.len() - 1)];
        if value == "throw" {
            return Err("switch check failed".to_owned());
        }
        Ok(value.as_bool().unwrap())
    }
    async fn submit(&self, session_id: &str, prompt: &RoomPrompt, options: &SubmitOptions) -> Result<bool, String> {
        let prompt = match prompt {
            RoomPrompt::Text(text) => Value::String(text.clone()),
            RoomPrompt::Parts(parts) => Value::Array(parts.clone()),
        };
        let mut shown = Map::new();
        if let Some(id) = &options.id {
            shown.insert("id".into(), json!(id));
        }
        if let Some(hop) = options.hop {
            shown.insert("hop".into(), json!(hop));
        }
        if let Some(row) = &options.room_row {
            shown.insert("roomRow".into(), json!(row));
        }
        if let Some(origin) = options.origin {
            shown.insert("origin".into(), json!(origin));
        }
        self.push(json!(["submit", session_id, prompt, Value::Object(shown)]));
        self.fire("submit");
        self.fails("submitThrows")?;
        Ok(self.script.get("submit").and_then(Value::as_bool).unwrap_or(true))
    }
    async fn abort(&self, session_id: &str) -> Result<(), String> {
        self.push(json!(["abort", session_id]));
        if self.script.get("abortRejects").is_some() { Err("abort failed".to_owned()) } else { Ok(()) }
    }
    fn persist(&self) -> PersistFuture {
        self.push(json!(["persist"]));
        let result = if self.script.get("persistRejects").is_some() { Err("persist boom".to_owned()) } else { Ok(()) };
        Box::pin(async move { result })
    }
}

fn members() -> Vec<MemberLabel> {
    let label = |id: &str, name: &str, route: Value| MemberLabel { id: id.into(), name: name.into(), route, description: String::new(), disabled: false };
    vec![label("bench", "Bench", json!({ "provider": "openai", "model": "gpt-5" })), label("alpha", "Alpha", Value::Null), label("gh", "Git Hub", Value::Null)]
}

/// The covered call's watch: logs what it is told and fails when asked to.
struct Watch {
    id: Value,
    log: Log,
    fails: bool,
}

#[async_trait]
impl CallFollow for Watch {
    async fn follow(&self, submission_id: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(json!(["follow", self.id, submission_id]));
        if self.fails { Err("record failed".to_owned()) } else { Ok(()) }
    }
}

fn hop_of(value: Option<&Value>) -> u32 {
    match value {
        Some(Value::Number(number)) => number.as_u64().map_or(0, |hop| u32::try_from(hop).unwrap()),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn call_of(spec: &Value, log: &Log, with_follow: Option<bool>) -> RoomCall {
    let call = &spec["call"];
    let id = call.get("id").and_then(Value::as_str).unwrap_or("");
    let follow: Option<Arc<dyn CallFollow>> = with_follow.map(|fails| Arc::new(Watch { id: call.get("id").cloned().unwrap_or(Value::Null), log: log.clone(), fails }) as Arc<dyn CallFollow>);
    let (each, _) = RoomCall::new("bench", id, hop_of(call.get("hop")), call.get("askedBy").and_then(Value::as_str).unwrap_or(""), call.get("relay").and_then(Value::as_str).unwrap_or(""), follow);
    if call.get("used") == Some(&json!(true)) {
        each.mark_used();
    }
    if call.get("followed") == Some(&json!(true)) {
        each.set_followed(true);
    }
    each
}

fn detail_json(call: &RoomCall) -> Option<Value> {
    let Settled { status, error, content } = call.detail()?;
    let mut detail = json!({ "status": status });
    if let Some(error) = error {
        detail["error"] = json!(error);
    }
    if let Some(content) = content {
        detail["result"] = json!({ "content": content });
    }
    Some(detail)
}

fn answer_json(answer: &Answer) -> Value {
    let word = match answer.result {
        TurnResult::Speech => "speech",
        TurnResult::Pass => "pass",
        TurnResult::Stopped => "stopped",
        TurnResult::Superseded => "superseded",
        TurnResult::Unavailable => "unavailable",
    };
    if answer.result == TurnResult::Speech {
        return json!({ "result": "speech", "mention": answer.mention.clone().unwrap_or_default() });
    }
    if !answer.failed && answer.usage.is_none() {
        return json!(word);
    }
    let mut shown = json!({ "result": word });
    if answer.failed {
        shown["failed"] = json!(true);
    }
    if let Some(usage) = &answer.usage {
        shown["usage"] = json!({ "kind": usage.kind, "provider": usage.provider, "model": usage.model });
        if let Some(reset) = usage.reset_at {
            shown["usage"]["resetAt"] = json!(reset);
        }
    }
    shown
}

#[tokio::test]
async fn a_whole_turn_does_what_the_node_turn_did_for_each_scripted_world() {
    for case in golden()["scenarios"].as_array().unwrap() {
        let script = &case["script"];
        let name = case["name"].as_str().unwrap();
        let log = Log::default();
        let state = Arc::new(TurnState::new(Arc::new(Run::default())));
        state.set_waiting(script.get("waiting").and_then(Value::as_bool).unwrap_or(true));
        for failure in script.get("failures").and_then(Value::as_array).into_iter().flatten() {
            state.push_failure(Failure { id: failure["id"].as_str().unwrap().into(), name: failure["name"].as_str().unwrap().into(), reason: failure["reason"].as_str().unwrap().into() });
        }
        let room = Arc::new(Mutex::new(RoomRecord {
            name: "Release room".into(),
            members: script.get("members").and_then(Value::as_array).map_or_else(|| vec!["bench".to_owned(), "alpha".into(), "gh".into()], |ids| ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect()),
            cursors: script.get("cursors").and_then(Value::as_object).map(|map| map.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default(),
            seen: script.get("seen").and_then(Value::as_object).map(|map| map.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()),
            share_tools: script.get("shareTools") == Some(&json!(true)),
            ..RoomRecord::default()
        }));
        let world = Arc::new(World { script: script.clone(), log: log.clone(), counts: Mutex::default(), clock: AtomicU64::new(1000), seq: AtomicU64::new(0), reads: AtomicU64::new(0), room: room.clone(), state: state.clone() });
        let host: Arc<dyn MemberHost> = world.clone();
        let labels: Arc<HashMap<String, MemberLabel>> = Arc::new(if script.get("labelled") == Some(&json!(false)) { HashMap::new() } else { members().into_iter().map(|member| (member.id.clone(), member)).collect() });
        let turn_in = &case["turn"];
        let turn = Turn {
            addressed: turn_in["addressed"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect(),
            instruction: turn_in["instruction"].as_str().unwrap().to_owned(),
            mentioned_by: turn_in["mentionedBy"].as_str().unwrap().to_owned(),
            scene: if turn_in["scene"] == "casual" { Scene::Casual } else { Scene::Work },
        };
        let calls: Vec<RoomCall> = case["callSpecs"].as_array().unwrap().iter().map(|spec| call_of(spec, &log, spec.get("follow").and_then(Value::as_str).map(|mode| mode == "throws"))).collect();
        let answer = match speak_in_room(&host, &state, &labels, "bench", &turn, &calls).await {
            Ok(answer) => answer_json(&answer),
            Err(error) => json!({ "threw": error }),
        };
        let mut got_calls = log.lock().unwrap().clone();
        for (spec, call) in case["callSpecs"].as_array().unwrap().iter().zip(&calls) {
            if let Some(detail) = detail_json(call) {
                got_calls.push(json!(["settled", spec["call"].get("id").cloned().unwrap_or(Value::Null), detail]));
            }
        }
        assert_eq!(answer, case["answer"], "{name}");
        assert_eq!(Value::Array(got_calls), case["calls"], "{name} calls");
        let (speaking, speaking_name, typing_id) = state.speaking();
        let got_state = json!({
            "speaking": speaking, "speakingName": speaking_name, "typingId": typing_id, "memberSession": state.member_session(),
            "approval": state.approval().unwrap_or(Value::Null), "waiting": state.waiting(),
            "failures": state.failures().iter().map(|f| json!({ "id": f.id, "name": f.name, "reason": f.reason })).collect::<Vec<_>>(),
        });
        assert_eq!(got_state, case["state"], "{name} state");
        let room = room.lock().unwrap();
        let map_json = |map: &HashMap<String, String>| Value::Object(map.iter().map(|(k, v)| (k.clone(), json!(v))).collect());
        let got_room = json!({
            "members": room.members, "cursors": map_json(&room.cursors), "seen": room.seen.as_ref().map_or(Value::Null, map_json),
            "lastSpeaker": room.last_speaker, "lastAt": room.last_at,
        });
        assert_eq!(got_room, case["room"], "{name} room");
        let flags: Vec<Value> = calls.iter().map(|call| json!({ "used": call.is_used(), "followed": call.is_followed() })).collect();
        let want: Vec<Value> = case["flags"].as_array().unwrap().iter().map(|flag| json!({ "used": flag["used"] == true, "followed": flag["followed"] == true })).collect();
        assert_eq!(flags, want, "{name} flags");
    }
}

struct Ids;

#[async_trait]
impl RoomTurnHost for Ids {
    fn room_id(&self) -> &str {
        "room01"
    }
    fn poll_ms(&self) -> u64 {
        0
    }
    fn now(&self) -> i64 {
        0
    }
    fn new_id(&self) -> String {
        "n1".to_owned()
    }
    fn republish(&self) {}
    fn log(&self, _: &str) {}
    async fn sleep(&self, _: u64) {}
    async fn post(&self, _: Vec<Value>) -> Result<(), String> {
        Ok(())
    }
    async fn read_snapshot(&self, _: &str) -> Result<Value, String> {
        Ok(Value::Null)
    }
}

#[tokio::test]
async fn the_calls_of_one_turn_combine_as_the_node_turn_combined_them() {
    for case in golden()["combined"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let log = Log::default();
        let calls: Vec<RoomCall> = case["specs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|spec| {
                let no_follow = spec.get("noFollow") == Some(&json!(true));
                call_of(&json!({ "call": spec }), &log, (!no_follow).then_some(false))
            })
            .collect();
        let combined = combined_call(&Ids, "bench", &calls);
        combined.follow(case["turnId"].as_str().unwrap()).await.unwrap();
        let got = json!({
            "agentId": combined.agent_id, "id": if combined.id.is_empty() { Value::Null } else { json!(combined.id) },
            "hop": if combined.hop == 0 { Value::Null } else { json!(combined.hop) },
            "askedBy": combined.asked_by, "relay": combined.relay, "relayOnly": combined.relay_only,
        });
        assert_eq!(got, case["combined"], "{name}");
        assert_eq!(Value::Array(log.lock().unwrap().clone()), case["log"], "{name} log");
        let flags: Vec<Value> = calls.iter().map(|call| json!({ "used": call.is_used(), "followed": call.is_followed() })).collect();
        let want: Vec<Value> = case["flags"].as_array().unwrap().iter().map(|flag| json!({ "used": flag["used"] == true, "followed": flag["followed"] == true })).collect();
        assert_eq!(flags, want, "{name} flags");
    }
}
