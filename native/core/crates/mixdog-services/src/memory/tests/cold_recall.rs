//! A recall while the embedding model is still loading, replayed from Node's public memory tool
//! (`record-memory-cold-recall.mjs`, `fixtures/memory-cold-recall`): the recorded entries in a real PostgreSQL, the recall
//! through `LocalMemory`'s `recall` tool with the provider's load held (the recording's embedding-worker seam), the
//! clock paused and moved only by explicit advances. The provider is asked as the product's recall asks it
//! (`RecallEmbedder`, memory/recall/readiness.rs, the one bounded cold wait).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::awaiting::awaiting;
use super::recall::Provider;
use crate::memory::embed::config::DEFAULT_MODEL_ID;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::ingest::SessionIngest;
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::pg::db::Schema;
use crate::memory::recall::period::Clock;
use crate::memory::recall::{Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::service::{LocalMemory, MemoryModule};
use crate::memory::tests::support::TestPg;

#[tokio::test]
async fn a_recall_while_the_model_loads_answers_as_node_and_the_load_goes_on() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/memory-cold-recall/golden.json")).expect("golden");
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": DEFAULT_MODEL_ID })).await.expect("schema");
    for row in golden["entries"].as_array().expect("entries") {
        // `search_tsv` is generated from the other columns.
        let columns: Vec<&str> = row.as_object().expect("row").keys().map(String::as_str).filter(|c| *c != "search_tsv").collect();
        let list = columns.join(", ");
        let sql = format!("INSERT INTO entries ({list}) SELECT {list} FROM jsonb_populate_record(NULL::entries, $1::text::jsonb)");
        db.execute(&sql, &[&row.to_string()]).await.expect("entry");
    }
    db.query("SELECT setval(pg_get_serial_sequence('entries','id'), (SELECT max(id) FROM entries))", &[]).await.expect("sequence");

    // The load: it says it started, then waits for the release and fails as the recorded worker answered.
    let started = Arc::new(tokio::sync::Notify::new());
    let (release, held) = tokio::sync::watch::channel(false);
    let cache = tempfile::tempdir().expect("cache");
    let (on_start, loads) = (started.clone(), Arc::new(std::sync::atomic::AtomicUsize::new(0)));
    let counted = loads.clone();
    let provider = Arc::new(EmbeddingProvider::installed_with_load(cache.path(), move || {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        on_start.notify_one();
        let mut held = held.clone();
        Box::pin(async move {
            let _ = held.wait_for(|released| *released).await;
            Err("model load failed".to_owned())
        })
    }));
    let now_ms = golden["clockMs"].as_i64().expect("clock");
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(move || Clock { now_ms, zone: chrono_tz::UTC }),
        embedder: Some(Arc::new(Provider(provider.clone()))),
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, Arc::new(move || now_ms), mixdog_rt::testing::tokens().durability_io);
    let memory = Arc::new(LocalMemory::new(db, pg.dir.path().join("data"), recall, ingest, mixdog_rt::testing::tokens().durability_io));
    let steps = golden["steps"].as_array().expect("steps");

    // 1. The recall starts the load and waits for it the recorded time, then answers while the load goes on.
    tokio::time::pause();
    let begun = tokio::time::Instant::now();
    let asking = memory.clone();
    let args = steps[0]["args"].clone();
    let answering = tokio::spawn(async move { asking.recall(args, &tokio_util::sync::CancellationToken::new()).await });
    awaiting("the recall to start the model's load", started.notified()).await;
    let wait = Duration::from_millis(steps[0]["coldWaitMs"].as_u64().expect("wait"));
    tokio::time::advance(wait - Duration::from_millis(1)).await;
    let early = answering.is_finished();
    // Tokio's timers fire on whole-millisecond ticks of the paused clock, which `begun` need not sit on: the wait
    // ends within the tick after it.
    tokio::time::advance(Duration::from_millis(2)).await;
    let text = awaiting("the recall after the cold wait", answering).await.expect("answers");
    let waited = (tokio::time::Instant::now() - begun).as_millis() as u64 - 1;
    // The running load holds a receiver of its own besides the closure's.
    let pending = release.receiver_count() == 2;
    assert_eq!(
        json!({ "answeredBeforeTheWait": early, "text": text, "coldWaitMs": waited,
                "loadPendingAfterAnswer": pending, "loadsStarted": loads.load(std::sync::atomic::Ordering::SeqCst) }),
        json!({ "answeredBeforeTheWait": false, "text": steps[0]["result"]["text"], "coldWaitMs": steps[0]["coldWaitMs"],
                "loadPendingAfterAnswer": steps[0]["loadPendingAfterAnswer"], "loadsStarted": steps[0]["loadsStarted"] }),
        "{}",
        steps[0]["label"]
    );

    // 2. The load ends as the recorded worker ended it, and the next recall answers as Node's did.
    release.send(true).expect("the load is held");
    let ended = awaiting("the held load to end", provider.warmup()).await;
    assert_eq!(ended.err().as_deref(), Some("model load failed"));
    let text = awaiting("the recall after the load ended", memory.recall(steps[1]["args"].clone(), &tokio_util::sync::CancellationToken::new())).await;
    assert_eq!(text, steps[1]["result"]["text"].as_str().expect("text"), "{}", steps[1]["label"]);
}

/// A recall tool call whose turn is stopped during the cold wait ends at that instant, refused as Node's request signal refuses it
/// (`embedRecallQuery` throws `abortReason(signal)`, `query-hybrid-search.mjs:40`; the proxy rejects the caller's call with the signal's
/// reason, `rpc.mjs:74-78`, so the outcome is `cancelled`, not a reply), and the model's load goes on. The clock is paused: the wait's 3 s would have to be advanced for the recall to end by the timer.
#[tokio::test]
async fn a_recall_stopped_during_the_cold_wait_ends_at_once_and_the_load_goes_on() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": DEFAULT_MODEL_ID })).await.expect("schema");
    let started = Arc::new(tokio::sync::Notify::new());
    let (release, held) = tokio::sync::watch::channel(false);
    let cache = tempfile::tempdir().expect("cache");
    let on_start = started.clone();
    let provider = Arc::new(EmbeddingProvider::installed_with_load(cache.path(), move || {
        on_start.notify_one();
        let mut held = held.clone();
        Box::pin(async move {
            let _ = held.wait_for(|released| *released).await;
            Err("model load failed".to_owned())
        })
    }));
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(|| Clock { now_ms: 1_700_000_000_000, zone: chrono_tz::UTC }),
        embedder: Some(Arc::new(Provider(provider.clone()))),
        session_cwd: None,
        lane: mixdog_rt::testing::tokens().durability_io,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, Arc::new(|| 1_700_000_000_000), mixdog_rt::testing::tokens().durability_io);
    let memory = Arc::new(LocalMemory::new(db, pg.dir.path().join("data"), recall, ingest, mixdog_rt::testing::tokens().durability_io));

    tokio::time::pause();
    let begun = tokio::time::Instant::now();
    let cancel = tokio_util::sync::CancellationToken::new();
    let (asking, token) = (memory.clone(), cancel.clone());
    let answering = tokio::spawn(async move { asking.recall_outcome_cancellable(&json!({ "query": "staging cluster restart" }), &token).await });
    awaiting("the recall to start the model's load", started.notified()).await;
    cancel.cancel();
    let outcome = awaiting("the stopped recall", answering).await.expect("answers");
    assert_eq!(tokio::time::Instant::now(), begun, "the stopped recall ended without the wait's time passing");
    assert!(outcome.cancelled, "the stopped recall is the caller's cancellation, not a reply: {}", outcome.text);
    assert_eq!(release.receiver_count(), 2, "the load goes on after the recall stopped waiting for it");
}

/// An embedder whose embed is held by the test: it says it started, waits for the release, then says it finished.
struct HeldEmbed {
    ready: bool,
    started: Arc<tokio::sync::Notify>,
    finished: Arc<tokio::sync::Notify>,
    release: tokio::sync::watch::Receiver<bool>,
}

#[async_trait::async_trait]
impl crate::memory::recall::readiness::ColdEmbed for HeldEmbed {
    type Error = String;
    fn is_ready(&self) -> bool {
        self.ready
    }
    fn can_warmup(&self) -> bool {
        true
    }
    fn warmup(&self) -> futures::future::BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    async fn embed(&self, _: &str, _: crate::memory::recall::readiness::EmbedRequest) -> Result<Vec<f32>, String> {
        self.started.notify_one();
        let _ = self.release.clone().wait_for(|released| *released).await;
        self.finished.notify_one();
        Ok(vec![1.0])
    }
    fn on_warmup_error(&self, _: &String) {}
}

/// A recall stopped while its query is embedded is released at once with the request's cancellation (`rpc.mjs:74-78`), and the
/// embedding is not dropped with the caller's future: it runs on, held here, and finishes on its own.
async fn a_stopped_embedding_releases_the_caller_and_runs_on(ready: bool) {
    mixdog_rt::testing::tokens();
    let (started, finished) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let (release, held) = tokio::sync::watch::channel(false);
    let embedder = Arc::new(HeldEmbed { ready, started: started.clone(), finished: finished.clone(), release: held });
    let cancel = tokio_util::sync::CancellationToken::new();
    let (asking, token) = (embedder.clone(), cancel.clone());
    let caller = tokio::spawn(async move {
        crate::memory::recall::readiness::embed_recall_query(&asking, Some("staging"), Duration::from_secs(3), &token, || "aborted".to_owned()).await
    });
    awaiting("the embedding to start", started.notified()).await;
    cancel.cancel();
    let outcome = awaiting("the stopped caller, while its embedding is still held", caller).await.expect("the caller");
    assert_eq!(outcome, Err("aborted".to_owned()), "the stopped caller is refused at once");
    release.send(true).expect("the embedding is held");
    awaiting("the embedding to finish on its own after its caller left", finished.notified()).await;
}

#[tokio::test]
async fn a_recall_stopped_during_a_warm_embedding_ends_at_once_and_the_embedding_goes_on() {
    a_stopped_embedding_releases_the_caller_and_runs_on(true).await;
}

#[tokio::test]
async fn a_recall_stopped_during_the_embedding_after_a_cold_load_ends_at_once_and_it_goes_on() {
    tokio::time::pause();
    a_stopped_embedding_releases_the_caller_and_runs_on(false).await;
}
