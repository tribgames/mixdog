//! Action dispatch cancellation without a PostgreSQL server, model, profile or network.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::pg::db::Schema;
use crate::memory::recall::{QueryEmbedder, RecallDeps};
use crate::memory::recall::period::Clock;

struct WaitingEmbedder {
    entered: Arc<Notify>,
    cancelled: Arc<AtomicUsize>,
}

#[async_trait]
impl QueryEmbedder for WaitingEmbedder {
    async fn query_vector(&self, _: &str, cancel: &CancellationToken) -> crate::memory::error::Result<Option<Vec<f32>>> {
        self.entered.notify_one();
        cancel.cancelled().await;
        self.cancelled.fetch_add(1, Ordering::SeqCst);
        Err(crate::memory::recall::aborted())
    }
}

fn memory(entered: Arc<Notify>, cancelled: Arc<AtomicUsize>, db_calls: Arc<AtomicUsize>) -> LocalMemory {
    // Any accidental SQL is counted and fails locally, never opening a socket.
    let db = Db::deferred(Schema::Memory, Arc::new(move || {
        db_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(crate::memory::error::MemoryError::rejected("unexpected database access")) })
    }), Arc::new(|| None));
    let lane = mixdog_rt::testing::tokens().durability_io;
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(|| Clock { now_ms: 1_700_000_000_000, zone: chrono_tz::UTC }),
        embedder: Some(Arc::new(WaitingEmbedder { entered, cancelled })),
        session_cwd: None,
        lane,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, Arc::new(|| 1_700_000_000_000), lane);
    LocalMemory::new(db, PathBuf::new(), recall, ingest, lane)
}

#[tokio::test]
async fn action_search_cancellation_reaches_the_inflight_embedder_without_starting_sql() {
    for query in [json!("restart"), json!(["restart", "snapshot"])] {
        let entered = Arc::new(Notify::new());
        let cancelled = Arc::new(AtomicUsize::new(0));
        let db_calls = Arc::new(AtomicUsize::new(0));
        let memory = memory(entered.clone(), cancelled.clone(), db_calls.clone());
        let cancel = CancellationToken::new();
        let args = json!({"action": "search", "query": query});
        let work = async {
            let (reply, ()) = tokio::join!(
                memory.memory_reply_cancellable(&args, &cancel),
                async { entered.notified().await; cancel.cancel(); },
            );
            reply
        };
        let reply = tokio::time::timeout(std::time::Duration::from_secs(2), work)
            .await.expect("action search must settle on caller cancellation, without releasing the embedding otherwise");
        assert!(reply.is_error && reply.text.contains("aborted"), "{reply:?}");
        assert!(cancelled.load(Ordering::SeqCst) > 0, "the in-flight embedding did not observe cancellation");
        assert_eq!(db_calls.load(Ordering::SeqCst), 0, "cancelled search must not start its hybrid SQL");
    }
}

#[tokio::test]
async fn an_already_cancelled_core_mutation_never_reaches_the_database() {
    let db_calls = Arc::new(AtomicUsize::new(0));
    let memory = memory(Arc::new(Notify::new()), Arc::new(AtomicUsize::new(0)), db_calls.clone());
    let cancel = CancellationToken::new();
    cancel.cancel();
    let reply = memory.memory_reply_cancellable(&json!({"action": "core", "op": "add", "element": "preference", "summary": "must not be stored"}), &cancel).await;
    assert!(reply.is_error && reply.text.contains("aborted"), "{reply:?}");
    assert_eq!(db_calls.load(Ordering::SeqCst), 0);
}

struct NoSession;
#[async_trait]
impl SessionSource for NoSession {
    async fn session(&self, _: Option<&str>) -> Option<SessionData> { None }
    async fn current_cwd(&self, _: Option<&str>) -> Option<String> { None }
    async fn profile_title(&self) -> String { String::new() }
}

struct CancelledModule(Arc<Notify>);
#[async_trait]
impl MemoryModule for CancelledModule {
    async fn memory(&self, _: Value) -> String { panic!("uncancellable entry must not run") }
    async fn memory_cancellable(&self, _: Value, cancel: &CancellationToken) -> String {
        self.0.notify_one();
        cancel.cancelled().await;
        "memory failed: This operation was aborted".into()
    }
    async fn recall(&self, _: Value, _: &CancellationToken) -> String { panic!("not a recall") }
}

#[tokio::test]
async fn memory_control_reports_caller_cancellation_instead_of_an_error_string_reply() {
    let entered = Arc::new(Notify::new());
    let service = MemoryService::new(Arc::new(CancelledModule(entered.clone())), Arc::new(NoSession));
    let cancel = CancellationToken::new();
    let args = json!({"args": {"action": "search", "query": "restart"}});
    let (reply, ()) = tokio::join!(
        service.memory_control(&args, &cancel),
        async { entered.notified().await; cancel.cancel(); },
    );
    assert!(matches!(reply, Err(CoreError::Cancelled { .. })), "{reply:?}");
}
