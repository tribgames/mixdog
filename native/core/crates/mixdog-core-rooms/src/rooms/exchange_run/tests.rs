//! One exchange against `fixtures/room-exchange/golden.json`, recorded from the real desktop
//! `agent-room-exchange.ts` driven with a scripted room host: every host call in order across the
//! exchanges a newer request chains, how each covered call ended, and the room left behind. The
//! chaining loop here is the scheduler's (`RoomCalls::start`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use super::{RoomExchangeHost, SupervisorStep, run_exchange};
use crate::rooms::calls::{Request, RoomCall, Run, Settled};
use crate::rooms::exchange::{Action, Decision, Scene};
use crate::rooms::member_turn::{MemberHost, PersistFuture, SubmitOptions};
use crate::rooms::turn_host::{MemberLabel, RoomRecord, RoomTurnHost, TurnState};
use crate::rooms::turn_prompt::RoomPrompt;

fn golden() -> Value {
    serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/room-exchange/golden.json"))).unwrap()
}

type Log = Arc<Mutex<Vec<Value>>>;

struct World {
    script: Value,
    log: Log,
    counts: Mutex<HashMap<String, u64>>,
    clock: AtomicU64,
    seq: AtomicU64,
    reads: Mutex<HashMap<String, usize>>,
    room: Arc<Mutex<RoomRecord>>,
    exists: AtomicBool,
    tracked: Mutex<Option<Arc<TurnState>>>,
    running: Mutex<Option<i64>>,
    owed: Mutex<Option<Vec<String>>>,
}

impl World {
    fn push(&self, entry: Value) {
        self.log.lock().unwrap().push(entry);
    }

    fn bump(&self, name: &str) -> u64 {
        let mut counts = self.counts.lock().unwrap();
        let count = counts.entry(name.to_owned()).or_insert(0);
        *count += 1;
        *count
    }

    /// Counts one call of `name` and runs the hooks scripted for that call; answers the count.
    fn fire(&self, name: &str) -> u64 {
        let count = self.bump(name);
        let tracked = self.tracked.lock().unwrap().clone();
        for hook in self.script["hooks"].as_array().into_iter().flatten() {
            if hook["on"] != name || hook.get("n").and_then(Value::as_u64).unwrap_or(1) != count {
                continue;
            }
            match hook["do"].as_str().unwrap() {
                "stop" => tracked.as_ref().unwrap().run.set_stopped(),
                "pending" => {
                    let wanted = hook.get("request").cloned().unwrap_or_else(|| json!({ "to": [], "waiting": false }));
                    let to = wanted["to"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect();
                    let request = Request { to, waiting: wanted["waiting"].as_bool().unwrap_or(false), only: wanted["only"].as_bool().unwrap_or(false), ..Request::default() };
                    *tracked.as_ref().unwrap().run.pending() = Some(request);
                }
                "deleteRoom" => self.exists.store(false, Ordering::SeqCst),
                "removeMember" => self.room.lock().unwrap().members.retain(|id| id != hook["member"].as_str().unwrap()),
                other => panic!("unknown hook {other}"),
            }
        }
        count
    }

    fn fails(&self, key: &str) -> Result<(), String> {
        match self.script.get(key).and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        }
    }
}

fn answered(text: &str) -> Value {
    json!({ "busy": false, "items": [
        { "kind": "user", "id": "u", "at": 1 },
        { "kind": "assistant", "id": "a", "text": text },
        { "kind": "turndone", "id": 9, "at": 5000, "status": "done", "finalAssistantId": "a" },
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
        self.fire("post");
        self.fails("postFails")
    }
    async fn read_snapshot(&self, session_id: &str) -> Result<Value, String> {
        let agent = session_id.trim_start_matches("sess_").to_owned();
        self.push(json!(["readSnapshot", session_id]));
        let list = self.script["answers"].get(&agent).and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!("Fine.")]);
        let read = {
            let mut reads = self.reads.lock().unwrap();
            let read = reads.entry(agent).or_insert(0);
            let now = *read;
            *read += 1;
            now
        };
        let next = list[read.min(list.len() - 1)].clone();
        self.fire("readSnapshot");
        if let Some(detail) = next.get("fail") {
            return Ok(json!({ "busy": false, "items": [{ "kind": "turndone", "id": 9, "at": 5000, "status": "failed", "detail": detail }] }));
        }
        if next.get("usage").is_some() {
            return Ok(json!({ "busy": false, "items": [{ "kind": "turndone", "id": 9, "at": 5000, "status": "failed", "quota": { "provider": "openai", "resetAt": 1700000000000_i64 } }] }));
        }
        Ok(answered(next.as_str().unwrap()))
    }
}

#[async_trait]
impl MemberHost for World {
    fn room(&self) -> Result<Arc<Mutex<RoomRecord>>, String> {
        if !self.exists.load(Ordering::SeqCst) && self.script.get("throwWhenGone") == Some(&json!(true)) {
            return Err("room gone".to_owned());
        }
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
        Ok(format!("sess_{}", member.id))
    }
    async fn switched_off(&self, agent_id: &str) -> Result<bool, String> {
        self.push(json!(["switchedOff", agent_id]));
        Ok(self.script["switchedOff"].as_array().is_some_and(|ids| ids.iter().any(|id| id == agent_id)))
    }
    async fn submit(&self, session_id: &str, prompt: &RoomPrompt, options: &SubmitOptions) -> Result<bool, String> {
        let size = match prompt {
            RoomPrompt::Text(text) => json!(text.encode_utf16().count()),
            RoomPrompt::Parts(_) => json!("parts"),
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
        self.push(json!(["submit", session_id, size, Value::Object(shown)]));
        self.fire("submit");
        self.fails("submitThrows")?;
        Ok(true)
    }
    async fn abort(&self, session_id: &str) -> Result<(), String> {
        self.push(json!(["abort", session_id]));
        Ok(())
    }
    fn persist(&self) -> PersistFuture {
        self.push(json!(["persist"]));
        self.fire("persist");
        let call = self.bump("persistCalls");
        let fails = self.script["persistFails"].as_array().is_some_and(|list| list.iter().any(|n| n.as_u64() == Some(call)));
        Box::pin(async move { if fails { Err("disk full".to_owned()) } else { Ok(()) } })
    }
}

#[async_trait]
impl RoomExchangeHost for World {
    fn exists(&self) -> bool {
        self.exists.load(Ordering::SeqCst)
    }
    fn track(&self, state: &Arc<TurnState>) {
        self.push(json!(["track"]));
        *self.tracked.lock().unwrap() = Some(state.clone());
    }
    fn untrack(&self, state: &Arc<TurnState>) -> bool {
        self.push(json!(["untrack"]));
        let mut tracked = self.tracked.lock().unwrap();
        if tracked.as_ref().is_some_and(|held| Arc::ptr_eq(held, state)) {
            *tracked = None;
            true
        } else {
            false
        }
    }
    fn fail_relays(&self, error: &str) {
        self.push(json!(["failRelays", error]));
    }
    async fn labels(&self) -> Result<HashMap<String, MemberLabel>, String> {
        self.push(json!(["labels"]));
        let disabled = |id: &str| self.script["disabled"].as_array().is_some_and(|ids| ids.iter().any(|each| each == id));
        Ok(members().into_iter().map(|mut member| {
            member.disabled = disabled(&member.id);
            (member.id.clone(), member)
        }).collect())
    }
    async fn decide_turn(&self, step: &SupervisorStep) -> Result<Option<Decision>, String> {
        let turns: Vec<Value> = step
            .decide
            .turns
            .iter()
            .map(|turn| {
                let mut shown = json!({ "id": turn.id, "result": result_word(turn.result) });
                if turn.failed {
                    shown["failed"] = json!(true);
                }
                shown
            })
            .collect();
        self.push(json!(["decideTurn", {
            "roomName": step.room_name,
            "members": step.members.iter().map(|member| json!({ "id": member.id, "name": member.name, "description": member.description })).collect::<Vec<_>>(),
            "rows": step.rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>(),
            "turns": turns,
            "mustPick": step.decide.must_pick,
            "last": step.decide.last,
            "remaining": { "messages": step.decide.remaining.messages, "steps": step.decide.remaining.steps },
        }]));
        let count = self.fire("decideTurn");
        let list = self.script.get("decisions").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!({ "action": "finish", "scene": "work" })]);
        let decision = &list[usize::try_from(count - 1).unwrap().min(list.len() - 1)];
        if decision == "throws" {
            return Err("model down".to_owned());
        }
        if decision.is_null() {
            return Ok(None);
        }
        let scene = match decision.get("scene").and_then(Value::as_str) {
            Some("casual") => Some(Scene::Casual),
            Some("work") => Some(Scene::Work),
            _ => None,
        };
        let action = match decision["action"].as_str().unwrap() {
            "speak" => Action::Speak { agent_id: decision["agentId"].as_str().unwrap().to_owned(), instruction: decision.get("instruction").and_then(Value::as_str).unwrap_or("").to_owned() },
            "unmanaged" => Action::Unmanaged,
            _ => Action::Finish,
        };
        Ok(Some(Decision { action, scene }))
    }
    fn republish_catalog(&self) {
        self.push(json!(["republishCatalog"]));
    }
    fn random(&self) -> f64 {
        self.script.get("random").and_then(Value::as_f64).unwrap_or(0.5)
    }
    fn max_rounds(&self) -> u32 {
        self.script.get("maxRounds").and_then(Value::as_u64).map_or(4, |n| u32::try_from(n).unwrap())
    }
    fn max_messages(&self) -> u32 {
        self.script.get("maxMessages").and_then(Value::as_u64).map_or(6, |n| u32::try_from(n).unwrap())
    }
    fn set_running(&self, started_at: Option<i64>) {
        *self.running.lock().unwrap() = started_at;
    }
    fn set_owed(&self, owed: Option<Vec<String>>) {
        *self.owed.lock().unwrap() = owed;
    }
    async fn cut_off(&self) {}
}

fn result_word(result: crate::rooms::exchange::TurnResult) -> &'static str {
    use crate::rooms::exchange::TurnResult;
    match result {
        TurnResult::Speech => "speech",
        TurnResult::Pass => "pass",
        TurnResult::Stopped => "stopped",
        TurnResult::Superseded => "superseded",
        TurnResult::Unavailable => "unavailable",
    }
}

fn members() -> Vec<MemberLabel> {
    let label = |id: &str, name: &str, route: Value, description: &str| MemberLabel { id: id.into(), name: name.into(), route, description: description.into(), disabled: false };
    vec![
        label("bench", "Bench", json!({ "provider": "openai", "model": "gpt-5" }), "tester"),
        label("alpha", "Alpha", Value::Null, "reviewer"),
        label("gh", "Git Hub", Value::Null, ""),
    ]
}

fn detail_json(detail: &Settled) -> Value {
    let mut shown = json!({ "status": detail.status });
    if let Some(error) = &detail.error {
        shown["error"] = json!(error);
    }
    if let Some(content) = &detail.content {
        shown["result"] = json!({ "content": content });
    }
    shown
}

#[tokio::test]
async fn an_exchange_does_what_the_node_exchange_did_for_each_scripted_room() {
    for case in golden()["scenarios"].as_array().unwrap() {
        let script = &case["script"];
        let name = case["name"].as_str().unwrap();
        let log = Log::default();
        let room = Arc::new(Mutex::new(RoomRecord {
            name: "Release room".into(),
            members: script.get("members").and_then(Value::as_array).map_or_else(|| vec!["bench".to_owned(), "alpha".into(), "gh".into()], |ids| ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect()),
            ..RoomRecord::default()
        }));
        let world = Arc::new(World {
            script: script.clone(),
            log: log.clone(),
            counts: Mutex::default(),
            clock: AtomicU64::new(1000),
            seq: AtomicU64::new(0),
            reads: Mutex::default(),
            room: room.clone(),
            exists: AtomicBool::new(true),
            tracked: Mutex::default(),
            running: Mutex::default(),
            owed: Mutex::default(),
        });
        let host: Arc<dyn RoomExchangeHost> = world.clone();
        let asked = &case["request"];
        let to: Vec<String> = asked.get("to").and_then(Value::as_array).map_or_else(Vec::new, |ids| ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect());
        let calls: Vec<RoomCall> = case["callSpecs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|spec| {
                let agent = spec["agentId"].as_str().unwrap_or("bench");
                let id = spec["call"].get("id").and_then(Value::as_str).unwrap_or("");
                let (mut call, _) = RoomCall::new(agent, id, 0, "", spec["call"].get("relay").and_then(Value::as_str).unwrap_or(""), None);
                let shown_id = if id.is_empty() { json!(agent) } else { json!(id) };
                let told = log.clone();
                call.on_settled = Some(Arc::new(move |detail: &Settled| told.lock().unwrap().push(json!(["settled", shown_id, detail_json(detail)]))));
                call
            })
            .collect();
        let mut request = Request {
            everyone: asked.get("everyone").and_then(Value::as_bool).unwrap_or(to.is_empty()),
            waiting: asked.get("waiting").and_then(Value::as_bool).unwrap_or(true),
            only: asked.get("only").and_then(Value::as_bool).unwrap_or(false),
            to,
            calls,
        };
        // The scheduler's loop: a request that arrived meanwhile runs next, unless stopped or gone.
        let run = Arc::new(Run::default());
        let result = loop {
            *run.calls_lock() = request.calls.clone();
            if let Err(error) = run_exchange(&host, &request, &run).await {
                break json!({ "threw": error });
            }
            let next = run.pending().take();
            match next {
                Some(next) if !run.stopped() && world.exists() => request = next,
                _ => break json!("ok"),
            }
        };
        assert_eq!(result, case["result"], "{name}");
        assert_eq!(Value::Array(log.lock().unwrap().clone()), case["calls"], "{name} calls");
        let room = room.lock().unwrap();
        let got_room = json!({
            "members": room.members,
            "cursors": Value::Object(room.cursors.iter().map(|(k, v)| (k.clone(), json!(v))).collect()),
            "running": world.running.lock().unwrap().map_or(Value::Null, |started| json!({ "startedAt": started })),
            "owed": world.owed.lock().unwrap().clone().map_or(Value::Null, |owed| json!(owed)),
        });
        assert_eq!(got_room, case["room"], "{name} room");
    }
}
