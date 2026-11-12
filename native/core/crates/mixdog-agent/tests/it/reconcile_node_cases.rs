//! Node's job reconcile cases (`fixtures/job-reconcile-cases`, `record-job-reconcile-cases.mjs`): the job registered
//! on a `JobBoard`, its terminal value set, then `reconcile_watchdog_partial` and `reconcile_finally` as Node's test
//! calls them; the settled row and the owner's notification against Node's.
#![allow(clippy::disallowed_methods)]

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::flow::reconcile::FinalStatus;
use mixdog_agent::agent_tool::flow::reconcile::JobHandle;
use mixdog_agent::agent_tool::flow::reconcile::reconcile_finally;
use mixdog_agent::agent_tool::flow::reconcile::reconcile_watchdog_partial;
use mixdog_agent::agent_tool::flow::result::WorkerResult;
use mixdog_agent::env::Clock;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::TaskResult;
use serde_json::Value;
use serde_json::json;

struct Fixed;
impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        1_772_359_200_000
    }
}

#[derive(Default)]
struct Owner(Mutex<Vec<String>>);

#[async_trait]
impl TaskNotifier for Owner {
    async fn finished(&self, _owner: &ThreadId, _surface: &str, _task_id: &str, _status: &str, notification: String) {
        self.0.lock().unwrap().push(notification);
    }
}

#[tokio::test]
async fn every_recorded_job_reconcile_case_is_nodes_settled_task_and_notice() {
    let path = format!("{}/../../fixtures/job-reconcile-cases/golden.json", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    mixdog_rt::testing::tokens();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let owner = Arc::new(Owner::default());
        let board = JobBoard::new(Arc::new(Fixed), Some(owner.clone()), None);
        let task_id = case["taskId"].as_str().unwrap().to_owned();
        board
            .register(NewJob {
                task_id: Some(task_id.clone()),
                label: case["label"].as_str().map(str::to_owned),
                operation: "spawn".into(),
                owner: JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() },
                ..NewJob::default()
            })
            .unwrap();
        let job = JobHandle::new(board, task_id, "spawn".into(), None);
        let value = WorkerResult { value: case["value"].clone(), error: None };
        job.set_terminal_value(value.clone());
        reconcile_watchdog_partial(&job, &value);
        assert_eq!(case["finalStatus"], "idle");
        reconcile_finally(&job, FinalStatus::Idle);
        let row = job.snapshot().unwrap();
        // The owner is told from a spawned task; let it run.
        for _ in 0..100 {
            if !owner.0.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let notices = owner.0.lock().unwrap().clone();
        let got = json!({
            "status": row.status,
            "terminalReason": row.terminal_reason,
            "error": row.error,
            "result": match row.result {
                Some(TaskResult::Json(v)) => v,
                Some(TaskResult::Content(text)) => json!(text),
                None => Value::Null,
            },
            "notification": notices.first().cloned().unwrap_or_default(),
        });
        if got != case["recorded"] || notices.len() != 1 {
            failures.push(format!("{}:\n  want {} (one notice)\n  got  {got} ({} notices)", case["case"], case["recorded"], notices.len()));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
