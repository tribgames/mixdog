//! The background embedding reindex: Node's `rootEmbedText` golden, the pacing of the flush
//! passes and the root-text sweep on paused time (scripted passes, no sockets), and the real
//! flush over a temp Postgres.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::memory::embed::engine::EmbedConfig;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::ingest::embed_flush::{FlushFailure, RawEmbedFlush, ROOT_EMBED_SWEEP_META_KEY, RootFlush, SweepStep, root_embed_text, start_root_embed_sweep};
use crate::memory::pg::db::Schema;
use crate::memory::reindex::{PASS_PAUSE, ROOT_SWEEP_PAUSE, ReindexSummary, SweepSummary, drain_embedding_reindex, run_root_embed_sweep};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

const ROOT_TEXT: &str = include_str!("../../../../../fixtures/tools/memory/root-embed-text/golden.json");

#[test]
fn root_embed_text_matches_node() {
    let golden: Value = serde_json::from_str(ROOT_TEXT).expect("golden");
    for case in golden["cases"].as_array().expect("cases") {
        let field = |name: &str| case[name].as_str();
        let got = root_embed_text(field("element"), field("summary"), field("role"), field("content"));
        assert_eq!(got, case["text"].as_str().expect("text"), "{}", case["name"]);
    }
}

fn secs(seconds: &[u64]) -> Vec<Duration> {
    seconds.iter().copied().map(Duration::from_secs).collect()
}

fn pass(attempted: usize, succeeded: usize, failed: &[i64], timed_out: bool) -> Result<RootFlush, FlushFailure> {
    Ok(RootFlush { attempted, succeeded, failed: failed.to_vec(), timed_out })
}

/// Runs the drain over `script(n)` for pass `n`; returns the answer and when each pass started.
async fn drain(
    script: impl Fn(usize) -> Result<RootFlush, FlushFailure>,
    cancel: &CancellationToken,
) -> (Result<ReindexSummary, FlushFailure>, Vec<Duration>) {
    let start = tokio::time::Instant::now();
    let starts = Mutex::new(Vec::new());
    let result = drain_embedding_reindex(
        || {
            let n = {
                let mut starts = starts.lock().expect("starts");
                starts.push(start.elapsed());
                starts.len() - 1
            };
            let answer = script(n);
            async move { answer }
        },
        cancel,
        PASS_PAUSE,
    )
    .await;
    (result, starts.into_inner().expect("starts"))
}

#[tokio::test(start_paused = true)]
async fn passes_go_on_a_second_apart_while_one_times_out_with_progress() {
    let (result, starts) = drain(
        |n| if n < 2 { pass(6, 5, &[7], true) } else { pass(2, 2, &[], false) },
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(result, Ok(ReindexSummary { passes: 3, attempted: 14, succeeded: 12, failed: 2 }));
    assert_eq!(starts, secs(&[0, 1, 2]));
}

#[tokio::test(start_paused = true)]
async fn a_timed_out_pass_without_progress_ends_the_drain() {
    let (result, starts) = drain(|_| pass(6, 0, &[1, 2, 3, 4, 5, 6], true), &CancellationToken::new()).await;
    assert_eq!(result, Ok(ReindexSummary { passes: 1, attempted: 6, succeeded: 0, failed: 6 }));
    assert_eq!(starts, secs(&[0]));
}

#[tokio::test(start_paused = true)]
async fn a_pass_that_finished_in_time_ends_the_drain() {
    let (result, starts) = drain(|_| pass(3, 3, &[], false), &CancellationToken::new()).await;
    assert_eq!(result, Ok(ReindexSummary { passes: 1, attempted: 3, succeeded: 3, failed: 0 }));
    assert_eq!(starts, secs(&[0]));
}

#[tokio::test(start_paused = true)]
async fn a_store_fault_ends_the_drain_as_it_is() {
    let (result, starts) = drain(|_| Err(FlushFailure::Store("commit failed".into())), &CancellationToken::new()).await;
    assert_eq!(result, Err(FlushFailure::Store("commit failed".into())));
    assert_eq!(starts, secs(&[0]));
}

#[tokio::test(start_paused = true)]
async fn a_cancel_ends_the_rest_between_passes_at_once() {
    let cancel = CancellationToken::new();
    let trip = cancel.clone();
    let canceller = tokio::spawn(async move {
        mixdog_rt::time::sleep(Duration::from_millis(300)).await;
        trip.cancel();
    });
    let (result, starts) = drain(|_| pass(6, 5, &[], true), &cancel).await;
    canceller.await.expect("canceller");
    assert_eq!(result, Err(FlushFailure::Cancelled));
    assert_eq!(starts, secs(&[0]));
}

async fn sweep(script: impl Fn(usize) -> Result<SweepStep, FlushFailure>) -> (Result<SweepSummary, FlushFailure>, Vec<Duration>) {
    let start = tokio::time::Instant::now();
    let starts = Mutex::new(Vec::new());
    let result = run_root_embed_sweep(
        || {
            let n = {
                let mut starts = starts.lock().expect("starts");
                starts.push(start.elapsed());
                starts.len() - 1
            };
            let answer = script(n);
            async move { answer }
        },
        &CancellationToken::new(),
        ROOT_SWEEP_PAUSE,
    )
    .await;
    (result, starts.into_inner().expect("starts"))
}

#[tokio::test(start_paused = true)]
async fn the_sweep_rests_four_seconds_between_steps_until_one_is_done() {
    let (result, starts) = sweep(|n| Ok(SweepStep { claimed: 8, replaced: if n < 2 { 8 } else { 3 }, done: n == 2 })).await;
    assert_eq!(result, Ok(SweepSummary { steps: 3, replaced: 19 }));
    assert_eq!(starts, secs(&[0, 4, 8]));
}

#[tokio::test(start_paused = true)]
async fn a_finished_sweep_is_one_step() {
    let (result, starts) = sweep(|_| Ok(SweepStep { claimed: 0, replaced: 0, done: true })).await;
    assert_eq!(result, Ok(SweepSummary { steps: 1, replaced: 0 }));
    assert_eq!(starts, secs(&[0]));
}

// ── over a temp Postgres, with the real model ──────────────────────────────

fn provider() -> Arc<EmbeddingProvider> {
    Arc::new(EmbeddingProvider::new(EmbedConfig {
        model_id: crate::memory::embed::config::DEFAULT_MODEL_ID.into(),
        cache_dir: PathBuf::from(std::env::var_os("MIXDOG_MEMORY_MODELS").expect("MIXDOG_MEMORY_MODELS")),
        ort_library: PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY")),
        dtype: None,
        sessions: 2,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    }))
}

async fn insert_root(db: &crate::memory::pg::db::Db, n: i64, element: &str, summary: &str, content: &str) -> i64 {
    db.query(
        "INSERT INTO entries(ts, role, content, source_ref, session_id, is_root, element, summary)
         VALUES ($1, 'user', $2, $3, 's1', 1, $4, $5) RETURNING id",
        &[&n, &content, &format!("ref:{n}"), &element, &summary],
    )
    .await
    .expect("insert")[0]
        .get(0)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs Postgres (MIXDOG_PG_RUNTIME), the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and the e5 files (MIXDOG_MEMORY_MODELS)"]
async fn roots_get_vectors_and_the_sweep_replaces_old_ones_then_finishes() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": crate::memory::embed::config::DEFAULT_MODEL_ID })).await.expect("schema");
    let provider = provider();
    provider.warmup().await.expect("model loads").expect("model installed");
    let a = insert_root(&db, 1, "build target", "The build uses the g-tools target", "please use g-tools").await;
    let b = insert_root(&db, 2, "release flow", "Releases go through the integrator", "who releases").await;
    let flush = Arc::new(RawEmbedFlush::new(db.clone(), Some(provider)));
    let cancel = CancellationToken::new();

    // Two callers that ask together share one flush.
    let (first, second) = tokio::join!(flush.flush_roots(&cancel), flush.flush_roots(&cancel));
    assert_eq!(first, second);
    let done = first.expect("flush");
    assert_eq!((done.attempted, done.succeeded, done.failed.clone(), done.timed_out), (2, 2, vec![], false));
    let embedded: i64 = db.query("SELECT count(*)::bigint FROM entries WHERE is_root = 1 AND embedding IS NOT NULL", &[]).await.expect("count")[0].get(0);
    assert_eq!(embedded, 2);

    // A sweep that starts above the newest root visits both, then is done and stays done.
    start_root_embed_sweep(&db).await.expect("start");
    let step = flush.sweep_root_text(8, &cancel).await.expect("step");
    assert_eq!(step, SweepStep { claimed: 2, replaced: 2, done: true });
    let state: Value = db.query("SELECT value FROM meta WHERE key = $1", &[&ROOT_EMBED_SWEEP_META_KEY]).await.expect("meta")[0].get(0);
    assert_eq!(state, json!({ "cursor": a.min(b), "done": true }));
    assert_eq!(flush.sweep_root_text(8, &cancel).await.expect("again"), SweepStep { claimed: 0, replaced: 0, done: true });
}
