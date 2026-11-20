//! A worker's turn: its prompt leaves its owner redacted, and marks carry both ways.
#![allow(clippy::disallowed_methods)]

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::flow::early::EarlyNotice;
use mixdog_agent::agent_tool::flow::reconcile::JobHandle;
use mixdog_agent::agent_tool::flow::seams::*;
use mixdog_agent::agent_tool::flow::turn::TurnPlan;
use mixdog_agent::agent_tool::flow::turn::TurnRunner;
use mixdog_agent::agent_tool::flow::worker_turns::Claim;
use mixdog_agent::agent_tool::flow::worker_turns::TurnOwner;
use mixdog_agent::env::Clock;
use mixdog_agent::response::Termination;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const START: i64 = 1_772_359_200_000;

struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        START
    }
}

/// Installs the test backend. Its ticker is per runtime (hang-lanes-138), so each test's deadlines
/// run on its own runtime's clock, paused or not, and nothing outlives the test.
fn backend() {
    mixdog_rt::testing::tokens();
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- the runner -----------------------------------------------------------------------------

fn turn_result(v: &Value) -> TurnResult {
    TurnResult {
        content: v["content"].as_str().unwrap_or_default().to_owned(),
        report_content: v.get("reportContent").and_then(Value::as_str).map(str::to_owned),
        termination: v.get("termination").and_then(Value::as_str).map(|t| match t {
            "truncated" => Termination::Truncated,
            "empty" => Termination::Empty,
            "refusal" => Termination::Refusal,
            other => panic!("termination {other}"),
        }),
        iterations: v.get("iterations").and_then(Value::as_u64).unwrap_or(1) as u32,
        tool_calls_total: v.get("toolCallsTotal").and_then(Value::as_u64).unwrap_or(0),
        stop_reason: v.get("stopReason").and_then(Value::as_str).map(str::to_owned),
    }
}

#[derive(Default)]
struct World {
    calls: Mutex<Vec<Value>>,
    notices: Mutex<Vec<Value>>,
    /// The worker session's rows: two before the turn, then what the script appends.
    rows: Mutex<Vec<AssistantText>>,
    steps: Vec<Value>,
    board: std::sync::OnceLock<JobBoard>,
    job: Mutex<Option<String>>,
    /// A session and the value it marked sensitive; the carries the runner asked for.
    secret: Option<(String, String)>,
    carried: Mutex<Vec<(String, String)>>,
}

impl World {
    fn log(&self, entry: impl Into<Value>) {
        lock(&self.calls).push(entry.into());
    }
}

struct Sess(Arc<World>);

#[async_trait]
impl TurnSessions for Sess {
    async fn message_count(&self, _: &str) -> usize {
        // Two rows existed before the turn; only the assistant rows after them are the turn's.
        2 + lock(&self.0.rows).len()
    }

    async fn assistant_texts(&self, _: &str, start: usize) -> Vec<AssistantText> {
        lock(&self.0.rows).iter().skip(start.saturating_sub(2)).cloned().collect()
    }

    fn not_done_report(&self, _: &str) -> String {
        String::new()
    }

    async fn run_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError> {
        let w = &self.0;
        w.log(format!("ask:{}@{}", request.prompt, request.cwd));
        for step in &w.steps {
            if let Some(diff) = step.get("tool").and_then(Value::as_str) {
                (request.hooks.on_tool_result)(&ToolResultMessage { ui_diff: Some(diff.to_owned()) });
            } else if let Some(text) = step.get("assistant").and_then(Value::as_str) {
                let replay = step.get("replay").and_then(Value::as_str).unwrap_or_default();
                lock(&w.rows).push(AssistantText { content: text.to_owned(), replay: replay.to_owned() });
            } else if let Some(terminal) = step.get("terminal") {
                if let Some(hook) = &request.hooks.on_terminal_result {
                    hook(&turn_result(terminal));
                }
            } else if step.get("cancel").is_some() {
                let id = lock(&w.job).clone().unwrap();
                w.board.get().unwrap().cancel(&id, "agent close", CancelNotice::Default);
            } else if let Some(result) = step.get("return") {
                return Ok(turn_result(result));
            } else if let Some(error) = step.get("throw") {
                return Err(TurnError {
                    message: error["message"].as_str().unwrap().to_owned(),
                    carried_report: error.get("carriedReport").and_then(Value::as_str).map(str::to_owned),
                    partial_handoff: error.get("partialHandoff").and_then(Value::as_str).map(str::to_owned),
                    notes: Vec::new(),
                });
            }
        }
        Ok(turn_result(&json!({ "content": "" })))
    }

    fn unload_runtime(&self, _: &str, reason: &str) {
        self.0.log(format!("unload:{reason}"));
    }

    fn carry_marks(&self, session_id: &str, owner_session_id: &str) {
        lock(&self.0.carried).push((session_id.to_owned(), owner_session_id.to_owned()));
    }

    fn redact_text(&self, session_id: &str, text: &str) -> String {
        match &self.0.secret {
            Some((session, value)) if session == session_id => text.replace(value.as_str(), "[redacted]"),
            _ => text.to_owned(),
        }
    }
}

/// A worker's prompt leaves its owner with the owner's sensitive values as the marker, and the marks of each follow
/// the text both ways (a value marked later in either reaches the other).
#[tokio::test(start_paused = true)]
async fn a_workers_prompt_leaves_its_owner_redacted_and_marks_carry_both_ways() {
    backend();
    let world = Arc::new(World { secret: Some(("lead".into(), "482913".into())), ..World::default() });
    let clock: Arc<dyn Clock> = Arc::new(FixedClock);
    let early = Arc::new(EarlyNotice::new(Arc::new(Owner(world.clone())), clock));
    let runner = TurnRunner::new(
        Arc::new(Sess(world.clone())),
        Arc::new(TurnsOwner(world.clone())),
        Arc::new(Reviews(world.clone())),
        Arc::new(Events(world.clone())),
        Arc::new(NoInbox),
        early,
    );
    let plan = TurnPlan {
        kind: TurnKind::Send,
        session_id: "sess_w1".into(),
        parent_session_id: Some("lead".into()),
        session_owner_id: None,
        tag: "scout".into(),
        agent: "worker".into(),
        identity: identity(false, "worker"),
        prompt: "enter 482913".into(),
        attachments: Vec::new(),
        context: None,
        cwd: "/work".into(),
        skill_selection: None,
        canonical: false,
    };
    runner.run(plan, None, None).await.ok();
    assert!(lock(&world.calls).contains(&json!("ask:enter [redacted]@/work")), "{:?}", lock(&world.calls));
    assert_eq!(*lock(&world.carried), [("sess_w1".to_owned(), "lead".to_owned()), ("lead".to_owned(), "sess_w1".to_owned())]);
}

struct Events(Arc<World>);
impl SubagentEvents for Events {
    fn start(&self, _: &str, _: &str, _: &str) {
        self.0.log("emit:start");
    }
    fn stop(&self, _: &str, _: &str, _: &str, status: &str) {
        self.0.log(format!("emit:stop:{status}"));
    }
}

/// The review store ignores a completion that has no owner (beginAgentTurnReview hands none).
struct Review(Arc<World>, Mutex<bool>, String);
impl ReviewHandle for Review {
    fn complete(&self, patches: Vec<String>) {
        let mut done = lock(&self.1);
        if !*done {
            *done = true;
            // The store takes a completion only with a patch (a fresh store holds no review).
            if !self.2.is_empty() && !patches.is_empty() {
                self.0.log(json!(["reviewComplete", patches]));
            }
        }
    }
}
struct Reviews(Arc<World>);
impl TurnReviews for Reviews {
    fn begin(&self, owner: &str, session: &str, tag: &str, agent: &str) -> Box<dyn ReviewHandle> {
        self.0.log(json!(["reviewBegin", owner, session, { "tag": tag, "agent": agent }]));
        Box::new(Review(self.0.clone(), Mutex::new(false), owner.to_owned()))
    }
}

struct Owner(Arc<World>);
impl OwnerNotify for Owner {
    fn notify(&self, owner: &str, text: &str, meta: &Value) -> bool {
        lock(&self.0.notices).push(json!({ "session": owner, "text": text, "meta": meta }));
        true
    }
}

struct NoInbox;
impl WorkerInbox for NoInbox {
    fn enqueue_completion(&self, _: &str, _: &str, _: &Value) -> bool {
        false
    }
}

/// The route's side of a claim: a claim opens the observation (`claim`), and the row a claim
/// settles when no turn started records the status it was released with (`release:<status>`).
/// The owner of the worker's turns as Node's fake logs it: every claim, and the release of each.
struct TurnsOwner(Arc<World>);
impl TurnOwner for TurnsOwner {
    fn claim(&self, _: &str, _: Option<Arc<JobHandle>>) -> Claim {
        self.0.log("claim");
        let world = self.0.clone();
        Claim::custom("sub-1".into(), Box::new(move |status| world.log(format!("release:{}", status.word()))))
    }
    fn observe(&self, _: &str) -> bool {
        true
    }
}

fn identity(spawn: bool, agent: &str) -> Map<String, Value> {
    let mut value = json!({ "tag": "scout", "sessionId": "sess_w1", "agent": agent, "provider": "openai", "model": "gpt-x" });
    if spawn {
        value["preset"] = json!("worker-preset");
        value["effort"] = json!("high");
        value["fast"] = json!(false);
    }
    value.as_object().unwrap().clone()
}

// ---- worker turns ---------------------------------------------------------------------------

// 2026-03-01T10:00:00.000Z
