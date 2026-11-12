//! Lays the recorded session of `fixtures/session-host-transcript-page-cases` (`record-session-host-transcript-page-cases.mjs`) into a data
//! directory a `mixdogd serve` then runs over: 300 assistant rows `c0`..`c299`, each `row <id> ` fifty times, and the rows named after the
//! directory (`n0`, `n1` for the changed session), stored the way the core stores rows of no turn (`thread/inheritedRows/append`, the
//! session store's own writer). A connection cannot store rows, so `benchmarks/rust-core/recorders/replay-session-host-transcript-page.mjs`
//! has its data directory made here:
//!   cargo-gate.ps1 run -p mixdog-app-server-daemon --example seed_transcript_page_session -- <data dir> [extra row id]...
#![allow(clippy::disallowed_methods, reason = "a tool of the replays: the data directory it is given")]

use std::sync::Arc;

use mixdog_core_api::CoreRequest;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::StoreThreads;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::transcript::RecordTranscript;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut args = std::env::args().skip(1);
    let data = std::path::PathBuf::from(args.next().expect("the data directory to lay the session into"));
    let extra: Vec<String> = args.collect();
    let tokens = mixdog_rt::testing::tokens();
    let root = data.clone();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let ownership = Arc::new(mixdog_core_api::domain::mock::MockOwnership::default());
    let store = Arc::new(StoreThreads::over_data_dir(&data, index, ownership, tokens.maintenance_io).await.expect("the thread store"));
    let rig = Rig::new();
    rig.clock.0.store(1_800_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let mut deps = rig.deps_parts(store);
    deps.transcript = Arc::new(RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(deps));
    let id = ThreadId::from("sess_page_host");
    directory.create_with_id(id.clone(), Header::new(), json!({})).await.expect("created");
    let handle = directory.open_handle(&id, &CallContext::internal("seed")).await.expect("open");
    let text = |row: &str| format!("row {row} ").repeat(50);
    let messages: Vec<Value> = (0..300).map(|n| format!("c{n}")).chain(extra).map(|row| json!({ "role": "assistant", "content": text(&row) })).collect();
    let append = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("seed") };
    handle.request(append).await.expect("the conversation is stored");
}
