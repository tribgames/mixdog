//! The agent tool's job board: an empty agent report notifies without a result body.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::env::Clock;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::TaskResult;
use serde_json::json;

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
struct Notices {
    sent: Mutex<Vec<(String, String)>>,
    arrived: tokio::sync::Notify,
}

#[async_trait]
impl TaskNotifier for Notices {
    async fn finished(&self, owner: &ThreadId, surface: &str, _task_id: &str, _status: &str, notification: String) {
        assert_eq!(surface, "agent");
        self.sent.lock().unwrap().push((owner.as_str().to_owned(), notification));
        self.arrived.notify_waiters();
    }
}

/// Installs the test backend. Its ticker is per runtime (hang-lanes-138), so each test's deadlines
/// run on its own runtime's clock, paused or not, and nothing outlives the test.
fn backend() {
    mixdog_rt::testing::tokens();
}




/// Waits until `want` notifications have been delivered (delivery runs on a spawned task of the
/// runtime's work pool), then lets any task already runnable finish. The bound only turns a
/// notification that never arrives into a failure.
async fn settle(notices: &Notices, want: usize) {
    let arrive = async {
        loop {
            let arrived = notices.arrived.notified();
            tokio::pin!(arrived);
            arrived.as_mut().enable();
            if notices.sent.lock().unwrap().len() >= want {
                break;
            }
            arrived.await;
        }
    };
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), arrive).await.expect("a notification never arrived");
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}
/// `renderBackgroundTaskNotification`: an agent's object result with `content: ""` delivers an
/// empty authored body (no `<result>` block), never the JSON of the object.
#[tokio::test(start_paused = true)]
async fn an_empty_agent_report_notifies_without_a_result_body() {
    backend();
    let notices = Arc::new(Notices::default());
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(1_000))), Some(notices.clone()), None);
    board
        .register(NewJob {
            task_id: Some("t1".into()),
            operation: "spawn".into(),
            label: Some("w".into()),
            owner: JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() },
            meta: JobMeta { tag: Some("w".into()), ..JobMeta::default() },
            ..NewJob::default()
        })
        .unwrap();
    board.complete(
        "t1",
        Completion { result: Some(TaskResult::Json(json!({ "agent": "worker", "content": "" }))), ..Completion::new("completed") },
    );
    settle(&notices, 1).await;
    let sent = notices.sent.lock().unwrap();
    assert!(sent[0].1.contains("<status>completed</status>"), "{}", sent[0].1);
    assert!(!sent[0].1.contains("<result>") && !sent[0].1.contains("worker"), "{}", sent[0].1);
}



