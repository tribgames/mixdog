//! `memory` `action:"status"` and the cycle state file the memory stack's scheduler keeps: what a store with roots, raw rows, core entries
//! and a recorded last run reads as, and what the scheduler writes once its cycles start.

use std::sync::Arc;

use serde_json::{Value, json};

use super::awaiting::awaiting;
use crate::memory::cycles::scheduler::{CycleScheduler, SchedulerDeps};
use crate::memory::ingest::SessionIngest;
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::pg::db::Schema;
use crate::memory::recall::period::Clock;
use crate::memory::recall::{Recall, RecallDeps};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::service::{LocalMemory, MemoryModule};
use crate::memory::tests::support::TestPg;

const NOW: i64 = 1_748_736_000_000;

/// No cycle runs in these tests.
struct NoEmbeddings;
#[async_trait::async_trait]
impl crate::memory::cycles::CycleEmbeddings for NoEmbeddings {
    async fn flush_dirty(&self, _cancel: &tokio_util::sync::CancellationToken) -> Result<crate::memory::cycles::DirtyFlush, String> {
        Err("no cycle runs".to_owned())
    }
    async fn sync_root(&self, _root_id: i64, _cancel: &tokio_util::sync::CancellationToken) -> Result<(), String> {
        Err("no cycle runs".to_owned())
    }
    async fn flush_raw(&self, _limit: usize) -> Result<(usize, usize), String> {
        Err("no cycle runs".to_owned())
    }
}

const SEED: &str = "
INSERT INTO entries (ts, role, content, source_ref, is_root) VALUES (0, 'user', 'x', 'ref-0', 1), (1, 'user', 'x', 'ref-1', 1), (2, 'user', 'x', 'ref-2', 1), (3, 'user', 'x', 'ref-3', 1),
  (4, 'user', 'x', 'ref-4', 0), (5, 'user', 'x', 'ref-5', 0), (6, 'user', 'x', 'ref-6', 0), (7, 'user', 'x', 'ref-7', 0), (8, 'user', 'x', 'ref-8', 0), (9, 'user', 'x', 'ref-9', 0);
UPDATE entries SET chunk_root = id WHERE is_root = 1;
UPDATE entries SET category = CASE WHEN id <= 3 THEN 'decision' ELSE 'fact' END, status = 'pending'::entry_status WHERE is_root = 1;
INSERT INTO core_entries (element, summary, category, project_id, agent_id, created_at, updated_at) VALUES ('tone', 'Answer briefly', 'rule', NULL, NULL, 0, 0);
INSERT INTO meta (key, value) VALUES ('state.cycle_last_run', '{\"cycle1\": 1748735680000, \"cycle1_heartbeat\": 1748735680000}'::jsonb)";

const LAST_RUN: i64 = 1_748_735_680_000;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn the_status_counts_roots_raw_rows_categories_core_memory_and_the_age_of_the_last_cycle() {
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    db.batch(SEED).await.expect("seed");

    // The cycles start: the ledger writes the file, and a task hydrates the last success from the store; it reads the clock for its write.
    let read = Arc::new(tokio::sync::Notify::new());
    let told = read.clone();
    let cycles = super::boot::idle_cycles();
    let state_file = pg.dir.path().join("memory-cycle-state.json");
    let scheduler = CycleScheduler::new(SchedulerDeps {
        db: db.clone(),
        llm: cycles.llm,
        embeddings: Arc::new(NoEmbeddings),
        config: cycles.config,
        state_file: state_file.clone(),
        lane: mixdog_rt::testing::tokens().maintenance_io,
        now: Arc::new(move || {
            told.notify_one();
            NOW
        }),
        timer: cycles.timer,
    });
    scheduler.start_cycles().await;
    while scheduler.ledger().health().last_success_at == 0 {
        awaiting("the hydration", read.notified()).await;
    }
    // Writes go one at a time: this one waits for the hydration's to end.
    scheduler.ledger().write().await;
    let state: Value = serde_json::from_slice(&std::fs::read(&state_file).expect("state file")).expect("json");
    assert_eq!(
        state,
        json!({
            "running": null,
            "backlog": { "unchunked": 0, "at": 0 },
            "cycles": { "cycle1": { "last_success_at": LAST_RUN, "last_error_at": 0, "last_error": null, "consecutive_failures": 0 } },
            "updatedAt": NOW,
        })
    );

    let lane = mixdog_rt::testing::tokens().durability_io;
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(move || Clock { now_ms: NOW, zone: chrono_tz::UTC }),
        embedder: None,
        session_cwd: None,
        lane,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, Arc::new(move || NOW), lane);
    let memory = LocalMemory::new(db, pg.dir.path().join("data"), recall, ingest, lane);
    let reply = memory.memory_reply(&json!({ "action": "status" })).await;
    let text = "entries: total=10 roots=4 cycle1_raw=6 (unchunked leaves)\nstatus: pending:4\ncategories: decision:3, fact:1\ncore_memory: user=1\nembedding_index: ready dims=384\nbootstrap: complete\nlast_cycle1: 5m ago";
    assert_eq!(reply.text, text);
    assert!(!reply.is_error);
    assert_eq!(
        serde_json::from_str::<Value>(&reply.envelope()).unwrap(),
        json!({ "text": text, "content": [{ "type": "text", "text": text }], "isError": false })
    );
    assert_eq!(memory.memory(json!({ "action": "status" })).await, text, "the module's route answers the same readout");
    scheduler.shutdown().await;
}
