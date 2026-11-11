//! `memory` `action:"status"` and the cycle state file, replayed from Node's memory runtime (`record-memory-status.mjs`,
//! `fixtures/memory-status`): the recorded store, the cycles started as the memory stack starts them (its scheduler over the
//! profile's `memory-cycle-state.json`), then the status through the memory tool, at the recording's clock.

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

/// No cycle runs in this replay.
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

#[tokio::test]
async fn the_status_and_the_cycle_state_file_are_nodes() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/memory-status/golden.json")).expect("golden");
    let now_ms = golden["clockMs"].as_i64().expect("clock");
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
    db.batch(golden["seedSql"].as_str().expect("seed")).await.expect("seed");

    // The cycles start: the ledger writes the file, and a task hydrates the last success from the store. The hydration
    // sets the success, then reads the clock for its write; each read is told here.
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
            now_ms
        }),
        timer: cycles.timer,
    });
    scheduler.start_cycles().await;
    while scheduler.ledger().health().last_success_at == 0 {
        awaiting("the hydration", read.notified()).await;
    }
    // Writes go one at a time: this one waits for the hydration's to end, and writes the same state.
    scheduler.ledger().write().await;
    let state: Value = serde_json::from_slice(&std::fs::read(&state_file).expect("state file")).expect("json");

    let lane = mixdog_rt::testing::tokens().durability_io;
    let recall = Recall::new(RecallDeps {
        db: db.clone(),
        clock: Arc::new(move || Clock { now_ms, zone: chrono_tz::UTC }),
        embedder: None,
        session_cwd: None,
        lane,
        estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
        trace: None,
    });
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, Arc::new(move || now_ms), lane);
    let memory = LocalMemory::new(db, pg.dir.path().join("data"), recall, ingest, lane);
    let reply = memory.memory_reply(&golden["args"]).await;
    let recorded = &golden["status"]["result"];
    assert_eq!(
        json!({ "text": reply.text, "isError": reply.is_error, "stateFile": state }),
        json!({ "text": recorded["text"], "isError": recorded["isError"], "stateFile": golden["stateFile"] })
    );
    assert_eq!(memory.memory(golden["args"].clone()).await, reply.text, "the module's route answers the same readout");
    scheduler.shutdown().await;
}
