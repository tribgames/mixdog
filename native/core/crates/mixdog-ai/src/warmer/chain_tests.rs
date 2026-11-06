//! The chain against Node: every scenario of `fixtures/cache-warm/golden.json` (recorded by
//! `record-cache-warm.mjs` driving `session/cache-warm.mjs` on a fake clock and fake timers) is
//! replayed step by step. Each step must leave the same events (timers set and cleared, sends,
//! billed rows, logs) and the same state (chain, touch, warm use, idle gaps, running turn), and
//! the two stores must write the same files.

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::chain::{ArmResponse, TimerHandle, WarmDeps, WarmRequest, WarmTarget, WarmTimers, Warmer, ineligibility};
use super::plan::{CacheStrategy, Prices, TurnKind, warm_delay_ms};
use super::stores::{GapRules, GapStore, TouchStore};
use super::stream::{WarmFailure, WarmUsage};
use crate::registry::warm::WarmLedger;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn num(value: f64) -> Value {
    if value.fract() == 0.0 { json!(value as i64) } else { json!(value) }
}

fn f(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

// ---- the request -------------------------------------------------------------------------------

struct Req {
    provider: String,
    model: String,
    session: String,
    sent_at: f64,
    kind: Option<String>,
    strategy: Option<CacheStrategy>,
    thinking: f64,
    effort: bool,
    warm_mode: bool,
}

const STRATEGY_1H: &str = r#"{"tools":"none","system":"1h","tier3":"1h","messages":"1h"}"#;

impl Req {
    /// `requestOf(spec)` of the recorder.
    fn of(spec: &Value) -> Arc<Self> {
        let opts = spec.get("opts").cloned().unwrap_or(json!({}));
        let strategy = match opts.get("cacheStrategy") {
            Some(value) => CacheStrategy::from_value(value),
            None => CacheStrategy::from_value(&serde_json::from_str(STRATEGY_1H).unwrap_or(Value::Null)),
        };
        let session = match opts.get("session") {
            Some(session) => session.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
            None => spec.get("sessionId").and_then(Value::as_str).unwrap_or("s1").to_owned(),
        };
        Arc::new(Self {
            provider: spec.get("provider").and_then(Value::as_str).unwrap_or("anthropic-oauth").to_owned(),
            model: spec.get("model").and_then(Value::as_str).unwrap_or("claude-opus-4-7").to_owned(),
            session,
            sent_at: f(spec, "sentAt"),
            kind: opts.get("requestKind").and_then(Value::as_str).map(str::to_owned),
            strategy,
            thinking: f(&opts, "thinkingBudgetTokens"),
            effort: opts.get("effort").is_some_and(|e| e.as_str().is_some_and(|s| !s.is_empty())),
            warm_mode: spec.get("noWarm") != Some(&json!(true)),
        })
    }
}

impl WarmRequest for Req {
    fn provider_name(&self) -> &str {
        &self.provider
    }
    fn model(&self) -> &str {
        &self.model
    }
    fn session_id(&self) -> &str {
        &self.session
    }
    fn sent_at(&self) -> f64 {
        self.sent_at
    }
    fn request_kind(&self) -> Option<&str> {
        self.kind.as_deref()
    }
    fn cache_strategy(&self) -> Option<CacheStrategy> {
        self.strategy.clone()
    }
    fn thinking_budget_tokens(&self) -> f64 {
        self.thinking
    }
    fn has_effort(&self) -> bool {
        self.effort
    }
    fn effort_levels_empty(&self) -> bool {
        self.model.starts_with("claude-3-5-haiku")
    }
    fn has_warm_mode(&self) -> bool {
        self.warm_mode
    }
}

// ---- the fake world ----------------------------------------------------------------------------

struct Pending {
    id: u64,
    at: f64,
    task: Option<BoxFuture<'static, ()>>,
}

#[derive(Default)]
struct Timers {
    list: Mutex<Vec<Pending>>,
    next: Mutex<u64>,
}

struct Handle {
    id: u64,
    world: Arc<World>,
}

impl TimerHandle for Handle {
    fn cancel(&self) {
        let mut list = lock(&self.world.timers.list);
        if let Some(at) = list.iter().position(|t| t.id == self.id) {
            list.remove(at);
            drop(list);
            self.world.push(json!({ "timer": "cleared" }));
        }
    }
}

struct World {
    clock: Mutex<f64>,
    events: Mutex<Vec<Value>>,
    timers: Timers,
}

impl World {
    fn now(&self) -> f64 {
        *lock(&self.clock)
    }
    fn set_now(&self, value: f64) {
        *lock(&self.clock) = value;
    }
    fn push(&self, event: Value) {
        lock(&self.events).push(event);
    }
}

struct FakeTimers(Arc<World>);

impl WarmTimers for FakeTimers {
    fn schedule(&self, delay_ms: f64, task: BoxFuture<'static, ()>) -> Box<dyn TimerHandle> {
        let world = &self.0;
        let id = {
            let mut next = lock(&world.timers.next);
            *next += 1;
            *next
        };
        let delay = delay_ms.max(0.0);
        let at = world.now() + delay;
        lock(&world.timers.list).push(Pending { id, at, task: Some(task) });
        world.push(json!({ "timer": "set", "delayMs": num(delay), "at": num(at) }));
        Box::new(Handle { id, world: world.clone() })
    }
}

struct Deps {
    world: Arc<World>,
    timers: FakeTimers,
    scenario: Value,
    in_flight: Mutex<bool>,
    sends: Mutex<usize>,
}

fn usage_of(value: &Value) -> WarmUsage {
    WarmUsage {
        input: f(value, "inputTokens"),
        output: f(value, "outputTokens"),
        cached: f(value, "cachedTokens"),
        cache_write: f(value, "cacheWriteTokens"),
        cache_write_1h: value.get("cacheWrite1hTokens").and_then(Value::as_f64),
        prompt_tokens: None,
        cost_usd: None,
    }
}

/// The slots of a usage the recorder's `billed` events carry, with Node's absent slots as zero.
fn slots(usage: &Value) -> Value {
    json!({ "cachedTokens": num(f(usage, "cachedTokens")), "cacheWriteTokens": num(f(usage, "cacheWriteTokens")), "inputTokens": num(f(usage, "inputTokens")), "outputTokens": num(f(usage, "outputTokens")) })
}

#[async_trait]
impl WarmDeps for Deps {
    fn now(&self) -> f64 {
        self.world.now()
    }
    fn timers(&self) -> &dyn WarmTimers {
        &self.timers
    }
    async fn enabled(&self) -> bool {
        self.scenario.get("enabled") != Some(&json!(false))
    }
    fn read_config_enabled(&self) -> bool {
        self.scenario.get("enabled") != Some(&json!(false))
    }
    fn turn_in_flight(&self, _session_id: &str) -> bool {
        *lock(&self.in_flight)
    }
    async fn last_sent_request(&self, session_id: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        self.world.push(json!({ "lastSent": session_id }));
        Ok(self.scenario.get("lastSent").map(|spec| Req::of(spec) as Arc<dyn WarmRequest>))
    }
    async fn providers_ready(&self) {}
    async fn provider_current(&self, _request: &dyn WarmRequest) -> bool {
        self.scenario.get("replaced") != Some(&json!(true))
    }
    async fn prices(&self, _request: &dyn WarmRequest, _ttl_ms: f64, _prompt_tokens: f64) -> Result<Prices, String> {
        Ok(match self.scenario.get("prices") {
            None => Prices { read: Some(0.5e-6), write: Some(6.25e-6), output: Some(25e-6) },
            Some(p) => Prices { read: p.get("read").and_then(Value::as_f64), write: p.get("write").and_then(Value::as_f64), output: p.get("output").and_then(Value::as_f64) },
        })
    }
    async fn send(
        &self,
        request: &dyn WarmRequest,
        target: &WarmTarget,
        _cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        let index = {
            let mut sends = lock(&self.sends);
            *sends += 1;
            *sends - 1
        };
        let step = self.scenario.get("sends").and_then(|s| s.get(index)).cloned().unwrap_or(json!({ "usage": { "cachedTokens": 70000, "cacheWriteTokens": 0 } }));
        self.world.push(json!({ "send": { "at": num(self.world.now()), "accountId": target.account_id, "provider": request.provider_name(), "model": request.model() } }));
        if let Some(by) = step.get("advance").and_then(Value::as_f64) {
            self.world.set_now(self.world.now() + by);
        }
        if let Some(report) = step.get("report") {
            let reported = usage_of(report);
            on_usage(&reported);
        }
        if let Some(by) = step.get("advance2").and_then(Value::as_f64) {
            self.world.set_now(self.world.now() + by);
        }
        let usage = step.get("usage").map(usage_of);
        match step.get("error").and_then(Value::as_str) {
            Some(message) => Err(WarmFailure { message: message.to_owned(), error: None, usage }),
            None => Ok(usage.unwrap_or_default()),
        }
    }
    async fn record_usage(&self, request: &dyn WarmRequest, usage: &WarmUsage, started_at: f64, account_id: &str) -> Result<(), String> {
        let shown = json!({ "cachedTokens": num(usage.cached), "cacheWriteTokens": num(usage.cache_write), "inputTokens": num(usage.input), "outputTokens": num(usage.output) });
        self.world.push(json!({ "billed": { "model": request.model(), "provider": request.provider_name(), "usage": shown, "startedAt": num(started_at), "accountId": account_id } }));
        Ok(())
    }
    fn log(&self, line: &str) {
        self.world.push(json!({ "log": line }));
    }
}

// ---- the replay --------------------------------------------------------------------------------

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/cache-warm/golden.json")).unwrap()
}

fn response_of(value: &Value) -> ArmResponse {
    let usage = value.get("usage").cloned().unwrap_or(json!({}));
    ArmResponse {
        input: f(&usage, "inputTokens"),
        cached: f(&usage, "cachedTokens"),
        cache_write: f(&usage, "cacheWriteTokens"),
        cache_write_1h: f(&usage, "cacheWrite1hTokens"),
        prompt_tokens: usage.get("promptTokens").and_then(Value::as_f64),
        account_id: value.get("providerMetadata").and_then(|m| m.get("accountRouting")).and_then(|a| a.get("accountId")).and_then(Value::as_str).map(str::to_owned),
    }
}

fn kind_of(name: &str) -> TurnKind {
    match name {
        "system" => TurnKind::System,
        "return" => TurnKind::Return,
        _ => TurnKind::Continuation,
    }
}

fn kind_name(kind: TurnKind) -> &'static str {
    match kind {
        TurnKind::System => "system",
        TurnKind::Return => "return",
        TurnKind::Continuation => "continuation",
    }
}

/// The recorder's `state` entry of one watched session.
fn state_of(id: &str, warmer: &Warmer, touches: &TouchStore, gaps: &GapStore) -> Value {
    let chain = warmer.chain_state(id).map_or(Value::Null, |c| {
        json!({ "ttlMs": num(c.ttl_ms), "touchAt": num(c.touch_at), "promptTokens": num(c.prompt_tokens), "accountId": c.account_id, "latencyMs": c.latency_ms.map_or(Value::Null, num), "refreshAt": num(c.refresh_at) })
    });
    let touch = touches.get(id).map_or(Value::Null, |t| {
        let mut map = Map::new();
        map.insert("touchAt".into(), num(t.touch_at));
        map.insert("ttlMs".into(), num(t.ttl_ms));
        map.insert("promptTokens".into(), num(t.prompt_tokens));
        if let Some(account) = t.account_id {
            map.insert("accountId".into(), json!(account));
        }
        Value::Object(map)
    });
    let warm_use = touches.warm_use(id).map_or(Value::Null, |u| json!({ "at": u.at, "provider": u.provider, "model": u.model, "accountId": u.account_id }));
    let kept: Vec<Value> = gaps
        .gaps(id)
        .iter()
        .map(|g| {
            let mut map = Map::new();
            map.insert("at".into(), num(g.at));
            map.insert("ms".into(), num(g.ms));
            if g.censored {
                map.insert("censored".into(), Value::Bool(true));
            }
            Value::Object(map)
        })
        .collect();
    let turn = warmer.turn(id).map_or(Value::Null, |t| json!({ "kind": kind_name(t.kind()), "returning": t.returning() }));
    json!({ "id": id, "chain": chain, "touch": touch, "warmUse": warm_use, "openAt": num(gaps.open_at(id)), "gaps": kept, "turn": turn })
}

async fn replay(row: &Value) -> Result<(), String> {
    let scenario = &row["scenario"];
    let name = row["name"].as_str().unwrap_or_default().to_owned();
    let world = Arc::new(World { clock: Mutex::new(scenario.get("now").and_then(Value::as_f64).unwrap_or(4_000_000_000_000.0)), events: Mutex::default(), timers: Timers::default() });
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let io = mixdog_rt::testing::tokens().durability_io;
    let log: Arc<dyn Fn(&str) + Send + Sync> = {
        let world = world.clone();
        Arc::new(move |line| world.push(json!({ "log": line })))
    };
    // Touches expire on the wall clock of the write; the recorded times are far ahead of it.
    let touches = Arc::new(TouchStore::open(dir.path().join("touches.json"), io, log.clone(), Arc::new(|| 1_800_000_000_000.0)).await.map_err(|e| e.to_string())?);
    let rules = GapRules { lookback_ms: super::plan::IDLE_RETURN_LOOKBACK_MS, window_ms: super::plan::IDLE_RETURN_WINDOW_MS, min_ms: warm_delay_ms(5.0 * 60_000.0) };
    let gaps = Arc::new({
        let world = world.clone();
        GapStore::open(dir.path().join("gaps.json"), io, rules, log, Arc::new(move || world.now())).await.map_err(|e| e.to_string())?
    });
    if let Some(preload) = scenario.get("gaps").and_then(Value::as_object) {
        for (id, list) in preload {
            for gap in list.as_array().into_iter().flatten() {
                let at = f(gap, "at");
                gaps.open_gap(id, at);
                let close = if gap.get("censored") == Some(&json!(true)) { at + super::plan::IDLE_RETURN_WINDOW_MS } else { at + f(gap, "ms") };
                gaps.close(id, close);
            }
        }
    }
    if let Some(preload) = scenario.get("touches").and_then(Value::as_object) {
        for (id, touch) in preload {
            touches.record(
                id,
                super::stores::Touch {
                    touch_at: f(touch, "touchAt"),
                    ttl_ms: f(touch, "ttlMs"),
                    prompt_tokens: f(touch, "promptTokens"),
                    account_id: touch.get("accountId").and_then(Value::as_str).map(str::to_owned),
                },
            );
        }
    }
    let deps = Arc::new(Deps { world: world.clone(), timers: FakeTimers(world.clone()), scenario: scenario.clone(), in_flight: Mutex::new(false), sends: Mutex::new(0) });
    let warmer = Warmer::new(deps.clone(), touches.clone(), gaps.clone(), WarmLedger::new());
    let mut turns = std::collections::HashMap::new();
    for (index, snapshot) in row["snapshots"].as_array().into_iter().flatten().enumerate() {
        let step = &snapshot["step"];
        let session = step.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let mark = lock(&world.events).len();
        match step["op"].as_str().unwrap_or_default() {
            "arm" => {
                let request = Req::of(&step["request"]);
                warmer.arm(session, Some(request as Arc<dyn WarmRequest>), &response_of(&step["response"]));
            }
            "advance" => {
                let to = f(step, "to");
                loop {
                    let due = {
                        let mut list = lock(&world.timers.list);
                        let earliest = list.iter().enumerate().filter(|(_, t)| t.at <= to).min_by(|a, b| a.1.at.total_cmp(&b.1.at).then(a.1.id.cmp(&b.1.id))).map(|(i, _)| i);
                        earliest.map(|i| list.remove(i))
                    };
                    let Some(mut due) = due else { break };
                    if due.at > world.now() {
                        world.set_now(due.at);
                    }
                    if let Some(task) = due.task.take() {
                        task.await;
                    }
                }
                if world.now() < to {
                    world.set_now(to);
                }
            }
            "clock" => world.set_now(f(step, "to")),
            "turn" => {
                let key = step.get("name").and_then(Value::as_str).unwrap_or(session).to_owned();
                if let Some(turn) = warmer.note_turn(session, kind_of(step["kind"].as_str().unwrap_or(""))) {
                    turns.insert(key, turn);
                }
            }
            "endTurn" => {
                let key = step.get("name").and_then(Value::as_str).unwrap_or(session);
                if let Some(turn) = turns.get(key) {
                    warmer.end_turn(session, turn);
                }
            }
            "activity" => {
                let request = step.get("request").filter(|r| !r.is_null()).map(Req::of);
                warmer.note_activity(session, request.as_deref().map(|r| r as &dyn WarmRequest));
            }
            "cancel" => warmer.cancel(session),
            "forget" => warmer.forget(session),
            "enable" => warmer.note_enabled(step["value"] == json!(true)),
            "inFlight" => *lock(&deps.in_flight) = step["value"] == json!(true),
            "rearm" => {
                let armed = warmer.rearm_after_restart().await;
                world.push(json!({ "rearmed": armed }));
            }
            other => return Err(format!("{name}: unknown op {other}")),
        }
        let events: Vec<Value> = lock(&world.events)[mark..].iter().cloned().map(normalized).collect();
        let want: Vec<Value> = snapshot["events"].as_array().cloned().unwrap_or_default().into_iter().map(normalized).collect();
        if events != want {
            return Err(format!("{name}: step {index} ({}) events\n got {}\nwant {}", step["op"], Value::Array(events), Value::Array(want)));
        }
        let watch: Vec<String> = match step.get("watch").and_then(Value::as_array) {
            Some(list) => list.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
            None => Some(session).filter(|s| !s.is_empty()).map(str::to_owned).into_iter().collect(),
        };
        let state: Vec<Value> = watch.iter().map(|id| state_of(id, &warmer, &touches, &gaps)).collect();
        let want_state = snapshot["state"].as_array().cloned().unwrap_or_default();
        if state != want_state {
            return Err(format!("{name}: step {index} ({}) state\n got {}\nwant {}", step["op"], Value::Array(state), Value::Array(want_state)));
        }
    }
    touches.flush().await;
    gaps.flush().await;
    let read = |file: &str| mixdog_statefile::read_content(&dir.path().join(file)).ok().flatten().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).unwrap_or(Value::Null);
    if read("touches.json") != row["files"]["touches"] {
        return Err(format!("{name}: touches file\n got {}\nwant {}", read("touches.json"), row["files"]["touches"]));
    }
    if read("gaps.json") != row["files"]["gaps"] {
        return Err(format!("{name}: gaps file\n got {}\nwant {}", read("gaps.json"), row["files"]["gaps"]));
    }
    Ok(())
}

/// A `billed` event's usage compared by the four slots Rust models.
fn normalized(mut event: Value) -> Value {
    if let Some(usage) = event.get_mut("billed").and_then(|b| b.get_mut("usage")) {
        *usage = slots(usage);
    }
    event
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_chain_scenario_runs_as_nodes_does() {
    let golden = golden();
    let rows = golden["chain"].as_array().unwrap();
    assert_eq!(rows.len(), 28);
    let mut failures = Vec::new();
    for row in rows {
        if let Err(message) = replay(row).await {
            failures.push(message);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn eligibility_equals_nodes_for_every_recorded_request() {
    let golden = golden();
    for row in golden["eligibility"].as_array().unwrap() {
        let request = Req::of(&row["spec"]);
        let got = ineligibility(request.as_ref());
        assert_eq!(got.map_or(Value::Null, Value::from), row["reason"], "{}", row["name"]);
    }
}
