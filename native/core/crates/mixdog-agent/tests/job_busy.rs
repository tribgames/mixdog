//! The count of an owner's busy agent jobs against Node's real guard
//! (`fixtures/agent/jobs/busy-count.json`, from `benchmarks/rust-core/recorders/record-job-busy-count.mjs`):
//! each scenario drives the board, and every `busy` op answers what `assertLeadIdle` counted in
//! the rows the job view listed for its scope, a running job dropped when its worker session
//! runs under another client process than the scope names.

use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::env::Clock;
use serde_json::Value;
use serde_json::json;

const GOLDEN: &str = include_str!("../../../fixtures/agent/jobs/busy-count.json");

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// The ticker task lives on the runtime that first asks for it; keep that one alive for the process.
fn long_lived_ticker() {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap());
    let _entered = runtime.enter();
    mixdog_rt::testing::tokens();
    mixdog_rt::ticker();
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn scope(op: &Value) -> Scope {
    let s = op.get("scope").unwrap_or(&Value::Null);
    Scope { caller_session_id: text(s, "session"), host_pid: s.get("pid").and_then(Value::as_u64) }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_busy_job_count_equals_nodes_activity_guard() {
    long_lived_ticker();
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let clock = Arc::new(TestClock(AtomicI64::new(scenario["start"].as_i64().unwrap())));
        let board = JobBoard::new(clock.clone(), None, None);
        // The worker sessions' own pids (`positiveInt` of their `clientHostPid`).
        let pids = scenario["sessions"].clone();
        let worker_pid = |session: &str| pids.get(session).and_then(Value::as_f64).map(f64::floor).filter(|pid| *pid >= 1.0).map(|pid| pid as u64);
        for (i, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let want = &scenario["results"][i];
            let id = text(op, "id").unwrap_or_default();
            match op["op"].as_str().unwrap() {
                "register" => {
                    board
                        .register(NewJob {
                            task_id: Some(id.clone()),
                            label: Some(id.clone()),
                            operation: "spawn".into(),
                            owner: JobOwner { caller_session_id: text(op, "caller"), owner_session_id: text(op, "owner"), host_pid: op.get("pid").and_then(Value::as_u64) },
                            meta: JobMeta { tag: Some(id.clone()), session_id: text(op, "sessionId"), ..JobMeta::default() },
                            ..NewJob::default()
                        })
                        .unwrap();
                }
                "complete" => {
                    board.complete(&id, Completion { notify: false, ..Completion::new(op["status"].as_str().unwrap()) });
                }
                "advance" => {
                    clock.0.fetch_add(op["ms"].as_i64().unwrap(), Ordering::SeqCst);
                }
                "busy" => {
                    let scope = scope(op);
                    let got = json!({ "listed": board.list_jobs_for_client(&scope, &worker_pid).len(), "busy": board.busy_count(&scope, &worker_pid) });
                    assert_eq!(&got, want, "{name} op {i}");
                    // The session-only form is the same count whenever the scope names no process.
                    if let (Some(session), None) = (&scope.caller_session_id, scope.host_pid) {
                        assert_eq!(board.running_count(session), want["busy"].as_u64().unwrap(), "{name} op {i}: running_count");
                    }
                }
                other => panic!("{name}: unknown op {other}"),
            }
        }
    }
}