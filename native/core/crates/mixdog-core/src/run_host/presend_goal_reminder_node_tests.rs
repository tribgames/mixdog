//! The Goal and todo reminder of a pre-send compaction (`pre-send-compact.mjs`): Node's recorded passes
//! (`fixtures/presend-goal-reminder/golden.json`, `benchmarks/rust-core/recorders/record-presend-goal-reminder.mjs`)
//! against the core's: a session thread opened with the recorded header, the Goal file Node's runtime wrote read by
//! the core's Goal runtime on the same fixed clock, a user turn started by the session actor, and in its run the
//! compactor the run host builds (`SessionCompactors`, wrapped as the factory wraps it in `GoalReminderCompactor`
//! over the run's port) asked for its savings preview and its pass over the recorded rows, at the budget the session's
//! policy resolves to. The whole compacted transcript (written back as the commit writes it), the turn's own
//! reminder and the session's reminder keys after the pass are compared.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::boundary::{CompactPolicy, CompactSettings};
use mixdog_agent::compact::summary_run::{SummaryFailure, SummarySender};
use mixdog_agent::env::{CompactRequest, CompactTrigger, Compactor};
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::{Method, OpId, ThreadId};
use mixdog_core_api::{CoreRequest, Reply, ThreadHandle};
use mixdog_core_goal::goal::{GoalClock, GoalConfig, GoalEnv, GoalRuntime, GoalTimers, Timer, TimerKind};
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_core_session::session::{RunOutcome, RunStart, SessionDirectory, StoredRows};
use serde_json::{Value, json};

use super::compaction_node_harness::{NoSummary, World, session_compactor};
use super::goal_reminder_compactor::GoalReminderCompactor;
use super::message_row::{message_of, row_of};
use super::summary_routes::{MaintainerRoute, SessionRoute, SummaryHost};

const GOLDEN: &str = include_str!("../../../../fixtures/presend-goal-reminder/golden.json");

/// The recorder's data root (relative to the working directory): its paths are measured in the pass.
const DATA_ROOT: &str = "mixdog-gr-data";

/// The session's header keys the recording keeps (`exclusions.header` of its manifest).
const KEYS: [&str; 3] = ["goalReminderRevision", "pendingGoalReminder", "goalStalledNotice"];

struct FixedClock(f64);
impl GoalClock for FixedClock {
    fn now(&self) -> f64 {
        self.0
    }
    fn monotonic(&self) -> Option<f64> {
        None
    }
}

/// No deadline is reached on a fixed clock.
struct NoTimers;
impl GoalTimers for NoTimers {
    fn after(&self, _: TimerKind, _: f64, _: Box<dyn FnOnce() + Send>) -> Timer {
        Timer::new(|| {})
    }
}

/// The session's own route: no summary is due in the recorded passes.
struct StubHost;
#[async_trait]
impl SummaryHost for StubHost {
    fn session(&self) -> SessionRoute {
        SessionRoute { provider: "stub".into(), model: "stub-model".into(), context_window: Some(40_000), summary_model: None }
    }
    fn maintainer_route(&self) -> Option<MaintainerRoute> {
        None
    }
    async fn provider_ready(&self, _: &str, _: bool) -> Result<bool, SummaryFailure> {
        Ok(true)
    }
    fn whole_window(&self, _: &str, _: &str) -> u64 {
        40_000
    }
    fn calibration(&self, _: &str, _: &str) -> f64 {
        1.0
    }
    fn sender(&self, _: &str) -> Arc<dyn SummarySender> {
        Arc::new(NoSummary)
    }
    async fn saved_catalog(&self, _: &str) -> Option<Vec<Value>> {
        None
    }
}

/// The data root, emptied on creation and removed on drop.
struct DataRoot(PathBuf);
impl DataRoot {
    #[allow(clippy::disallowed_methods, reason = "test setup")]
    fn new() -> Self {
        let _ = std::fs::remove_dir_all(DATA_ROOT);
        // A delete Windows still holds pending leaves the directory standing for a moment; each case's files are its
        // own session's, so what remains of the previous case is never read.
        std::fs::create_dir_all(DATA_ROOT).unwrap();
        Self(PathBuf::from(DATA_ROOT))
    }
}
impl Drop for DataRoot {
    #[allow(clippy::disallowed_methods, reason = "test cleanup")]
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The recorder's normalisation: the data root is `<DATA>` and the separators of a path under it `/`.
fn normalize(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            let mut out = String::new();
            let mut rest = text.as_str();
            while let Some(at) = rest.find(DATA_ROOT) {
                out.push_str(&rest[..at]);
                out.push_str("<DATA>");
                let tail = &rest[at + DATA_ROOT.len()..];
                let end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || "_.-/\\".contains(c))).unwrap_or(tail.len());
                out.push_str(&tail[..end].replace('\\', "/"));
                rest = &tail[end..];
            }
            out.push_str(rest);
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), normalize(v))).collect()),
        other => other.clone(),
    }
}

/// What the run saw: the turn's own reminder, the preview's verdict and the compacted rows.
struct Seen {
    turn_reminder: Option<String>,
    reduces: bool,
    changed: bool,
    rows: Vec<Value>,
}

#[allow(clippy::disallowed_methods, reason = "test setup writes the Goal file Node wrote")]
async fn replay(case: &Value) -> Value {
    let _root = DataRoot::new();
    let id = ThreadId::from(case["sessionId"].as_str().unwrap().to_owned());
    if let Some(file) = case["goalFile"].as_str() {
        std::fs::create_dir_all(Path::new(DATA_ROOT).join("goals")).unwrap();
        std::fs::write(Path::new(DATA_ROOT).join("goals").join(format!("{id}.json")), file).unwrap();
    }
    let header = case["header"].as_object().unwrap().clone();
    let input: Vec<Value> = case["input"].as_array().unwrap().clone();

    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    let tokens = mixdog_rt::testing::tokens();
    deps.goals = Arc::new(GoalRuntime::new(
        GoalConfig::new(DATA_ROOT),
        GoalEnv { clock: Arc::new(FixedClock(case["now"].as_f64().unwrap())), timers: Arc::new(NoTimers), ..GoalEnv::system(tokens.durability_io) },
    ));
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<Seen>();
    let (read_tx, read_rx) = tokio::sync::oneshot::channel::<()>();
    let pending = Arc::new(Mutex::new(Some((seen_tx, read_rx))));
    let (thread, run_header) = (id.clone(), header.clone());
    rig.set_script(Arc::new(move |run: RunStart| {
        let (seen_tx, read_rx) = pending.lock().unwrap().take().expect("one turn");
        let (thread, header, input) = (thread.clone(), run_header.clone(), input.clone());
        Box::pin(async move {
            let settings = CompactSettings { context_window: Some(40_000), token_calibration: 1.0, ..CompactSettings::default() };
            let budget = CompactPolicy::resolve(&CompactSettings { auto: true, ..settings.clone() }).expect("a policy").target_budget();
            let rows = Arc::new(StoredRows::new());
            let messages: Vec<AgentMessage> = input
                .iter()
                .map(|row| {
                    let message = message_of(row).unwrap_or_else(|e| panic!("{e}: {row}"));
                    rows.record(&message, row.clone());
                    message
                })
                .collect();
            let inner = session_compactor(World::unsaved("stub", Arc::new(StubHost), None), thread.as_str(), &header, settings, rows, Path::new(DATA_ROOT)).await;
            let compactor = GoalReminderCompactor::new(inner, run.port.clone());
            compactor.prepare(&messages).await;
            let request = || CompactRequest { messages: &messages, budget_tokens: budget, trigger: CompactTrigger::Auto, require_reduction: true, reference_latest_attachments: false, active_turn: true, latest_user_prefix: "" };
            let reduces = compactor.reduces(&request()).await;
            let output = compactor.compact(request()).await.expect("the pass");
            // Every message of the run is stored before its header is read: a change the header does not hold yet is
            // acked once stored, after the records the lane accepted before it (an empty one is acked at once). The key
            // is not among those compared.
            let mut barrier = serde_json::Map::new();
            barrier.insert("replayBarrier".into(), json!(true));
            run.port.save_header(mixdog_store::schema::record::HeaderChange { set: barrier, unset: Vec::new() }).await.expect("barrier");
            let changed = !output.skipped && output.messages != messages;
            let _ = seen_tx.send(Seen { turn_reminder: run.goal_reminder.map(|r| r.content), reduces, changed, rows: output.messages.iter().map(row_of).collect() });
            let _ = read_rx.await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    directory.create_with_id(id.clone(), header, json!({})).await.expect("the session");
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let started = handle
        .request(CoreRequest {
            method: Method("turn/start"),
            params: json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "Continue the approved task." } }),
            op: Some(OpId::from("op-1")),
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "the turn starts");
    let seen = seen_rx.await.expect("the run's pass");
    let after_header = SessionThreads::new(directory.clone()).header(&id).await.expect("the header");
    let _ = read_tx.send(());
    let after: serde_json::Map<String, Value> = KEYS.iter().filter_map(|key| Some(((*key).to_owned(), after_header.get(*key)?.clone()))).collect();
    normalize(&json!({
        "turnReminder": seen.turn_reminder,
        "budget": budget_of(),
        "compactChanged": seen.reduces && seen.changed,
        "output": seen.rows,
        "after": after,
    }))
}

fn budget_of() -> u64 {
    CompactPolicy::resolve(&CompactSettings { auto: true, context_window: Some(40_000), token_calibration: 1.0, ..CompactSettings::default() }).expect("a policy").target_budget()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pre_send_goal_reminder_equals_node() {
    let golden: Value = serde_json::from_str(&mixdog_testkit::todo_wording(GOLDEN)).unwrap();
    let mut replayed = 0;
    for case in golden["cases"].as_array().unwrap() {
        let want = json!({
            "turnReminder": case["turnReminder"],
            "budget": case["budget"],
            "compactChanged": case["compactChanged"],
            "output": case["output"],
            "after": case["after"],
        });
        assert_eq!(replay(case).await, want, "{}", case["name"]);
        replayed += 1;
    }
    assert_eq!(replayed, 6, "every recorded case is replayed");
}
