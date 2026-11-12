//! `thread/items/list` reads the newest rows of the history it pages (`ThreadStore::history_tail`), not the whole of it. Driven
//! over the real store: every call shape's page from the tail is compared with the page of the whole history, the one the
//! reads built before they read tails (`history_rows`, every row projected, one window over all of it), through both the
//! store's own `history_tail` and the trait's default one.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;

use super::SessionLanes;
use super::ThreadStore;
use super::Transcript;
use super::reads::History;
use super::reads::history_tail;
use super::reads::items_window;
use super::reads::list_from_tail;
use super::seams::AppendPosition;
use super::seams::BarrierError;
use super::seams::CommitRecord;
use super::seams::EncodedRecord;
use super::seams::SessionLog;
use super::store::StoreThreads;
use super::transcript::RecordTranscript;
use mixdog_protocol::ThreadItem;

const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

type Log = Arc<Mutex<Box<dyn SessionLog>>>;

fn commit(value: Value) -> CommitRecord {
    let record: Record = serde_json::from_value(value).expect("a record");
    let encoded = EncodedRecord(mixdog_store::encode::encode_record(record.clone()).expect("encodes"));
    CommitRecord { record: Arc::new(record), encoded }
}

/// A row the transcript shows as the stored Node display row `body`.
fn row(iid: &str, turn: &str, visible: bool, body: Value) -> CommitRecord {
    commit(json!({"k":"item","iid":iid,"turn":turn,"form":"display","model":false,"visible":visible,"refs":[],"body":{"inline":body}}))
}

fn assistant(i: usize, turn: &str, visible: bool) -> CommitRecord {
    let id = format!("a{i}");
    row(&id, turn, visible, json!({ "kind": "assistant", "id": id, "text": format!("{i}{}", "x".repeat(i % 9)) }))
}

fn user(iid: &str, submission: &str, turn: &str) -> CommitRecord {
    row(iid, turn, true, json!({ "kind": "user", "id": iid, "text": "hi", "clientSubmissionId": submission }))
}

/// `n` plain rows `a0..`.
fn plain(n: usize) -> Vec<CommitRecord> {
    (0..n).map(|i| assistant(i, "t0", true)).collect()
}

/// A history of 700 stored rows: hidden rows, turns of 50, user rows shown under their submission ids, one of them under an
/// id (`a650`) an assistant row far newer also shows, a user row (`u640`) whose item id the newest rows show and whose
/// submission id is another, one named as an older assistant row (`a30`), and a compaction in the middle.
fn big() -> Vec<CommitRecord> {
    let mut rows = Vec::new();
    for i in 0..700 {
        let turn = format!("t{}", i / 50);
        rows.push(match i {
            100 => user("u100", "a650", &turn),
            640 => user("a30", "s640", &turn),
            _ if i % 40 == 0 => user(&format!("u{i}"), &format!("s{i}"), &turn),
            _ => assistant(i, &turn, i % 17 != 3),
        });
        if i == 350 {
            rows.push(commit(json!({"k":"compacted","cid":"c350","dropped_count":10,
                "replacement":{"inline":[{"iid":"c350-0","body":{"role":"user","content":"summary"}}]}})));
        }
    }
    rows
}

async fn index_over(data: &Path, tokens: LaneTokens) -> SqliteStore {
    let root = data.to_path_buf();
    LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index")
}

async fn create(threads: &Arc<StoreThreads>, tokens: LaneTokens, thread: &str, rows: Vec<CommitRecord>) -> Log {
    let (threads, thread) = (threads.clone(), ThreadId::from(thread));
    let session = commit(json!({"k":"session","v":2,"id":thread.as_str(),"log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
        let (mut log, _) = threads.create_log(lane, &thread, &session).expect("created");
        log.commit(lane, &rows).expect("appended");
        Arc::new(Mutex::new(log))
    })
    .expect("lane")
    .await
    .expect("job ran")
}

/// The trait's own `history_tail`: every other method is the store's.
struct DefaultTail(Arc<StoreThreads>);

impl ThreadStore for DefaultTail {
    fn read_head(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<super::seams::HeadRead, CoreError> {
        self.0.read_head(lane, id)
    }
    fn read_header(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<mixdog_store::schema::record::Header, CoreError> {
        self.0.read_header(lane, id)
    }
    fn read_log_id(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<String, CoreError> {
        self.0.read_log_id(lane, id)
    }
    fn read_window(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, head: &super::seams::HeadRead) -> Result<super::seams::WindowRead, CoreError> {
        self.0.read_window(lane, id, head)
    }
    fn decode(&self, lane: &InLane<mixdog_rt::CpuInteractive>, id: &ThreadId, head: super::seams::HeadRead, window: super::seams::WindowRead) -> Result<super::seams::OpenedLog, CoreError> {
        self.0.decode(lane, id, head, window)
    }
    fn user_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<ItemRecord>, CoreError> {
        self.0.user_rows(lane, id)
    }
    fn history_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<(u64, Vec<ItemRecord>), CoreError> {
        self.0.history_rows(lane, id)
    }
    fn thread_op(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<super::seams::StoredOp>, CoreError> {
        self.0.thread_op(lane, id, op)
    }
    fn fenced_ops(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError> {
        self.0.fenced_ops(lane, id)
    }
    fn history_row(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<(u64, ItemRecord)>, CoreError> {
        self.0.history_row(lane, id, iid)
    }
    fn compaction_entry(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        self.0.compaction_entry(lane, id, iid)
    }
    fn context_io(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, read: Option<super::seams::ContextRead>) -> Result<super::seams::ContextRead, CoreError> {
        self.0.context_io(lane, id, read)
    }
    fn session_meta(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<Option<super::seams::SessionMeta>, CoreError>> {
        self.0.session_meta(id)
    }
    fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>> {
        self.0.purge_deleted()
    }
    fn copies_of(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<super::seams::OffloadCopies, CoreError>> {
        self.0.copies_of(id)
    }
    fn record_offload_scan(&self, session: &str, ordinal: i64, sources: Vec<String>) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
        self.0.record_offload_scan(session, ordinal, sources)
    }
    fn context_cpu(&self, lane: &InLane<mixdog_rt::CpuInteractive>, read: super::seams::ContextRead) -> Result<super::seams::ContextStep, CoreError> {
        self.0.context_cpu(lane, read)
    }
    fn open_log(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, at: AppendPosition) -> Result<Box<dyn SessionLog>, BarrierError> {
        self.0.open_log(lane, id, at)
    }
    fn create_log(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, session: &CommitRecord) -> Result<(Box<dyn SessionLog>, u64), BarrierError> {
        self.0.create_log(lane, id, session)
    }
}

fn lanes(tokens: LaneTokens) -> SessionLanes {
    SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io }
}

/// The page of the whole history, as the reads built it before they read tails.
async fn whole(store: &Arc<dyn ThreadStore>, tokens: LaneTokens, id: &ThreadId, params: &Value) -> Result<Reply, CoreError> {
    let token = CancellationToken::new();
    let (thread, reading) = (id.clone(), store.clone());
    let (rev, records) = tokens.interactive_io.submit(&token, move |lane| reading.history_rows(lane, &thread)).expect("lane").await.expect("job ran")?;
    let transcript = RecordTranscript::new();
    let rows = tokens
        .cpu_interactive
        .submit(&token, move |lane| records.iter().flat_map(|record| transcript.rows(lane, record)).collect::<Vec<(ThreadItem, usize)>>())
        .expect("lane")
        .await
        .expect("job ran");
    Ok(items_window(id, rev, &rows, true, &serde_json::from_value(params.clone()).expect("params"))?.expect("the whole history decides every page"))
}

/// The page read from the newest rows, and the most rows it read.
async fn tailed(store: &Arc<dyn ThreadStore>, tokens: LaneTokens, id: &ThreadId, params: &Value) -> (Result<Reply, CoreError>, usize) {
    let transcript: Arc<dyn Transcript> = Arc::new(RecordTranscript::new());
    let widest = std::cell::Cell::new(0);
    let got = list_from_tail(id, &serde_json::from_value(params.clone()).expect("params"), |n| {
        widest.set(widest.get().max(n));
        let (store, transcript, id) = (store.clone(), transcript.clone(), id.clone());
        async move {
            let (History { rev, rows }, complete) = history_tail(&store, &transcript, lanes(tokens), &id, n).await?;
            Ok((rev, rows, complete))
        }
    })
    .await;
    (got, widest.get())
}

fn shapes_of_big() -> Vec<Value> {
    let mut shapes = Vec::new();
    for limit in [1, 128, 129, 256, 257, 512] {
        shapes.push(json!({ "limit": limit }));
    }
    shapes.push(json!({}));
    shapes.push(json!({ "limit": 50, "byteBudget": 300 }));
    shapes.push(json!({ "limit": 20, "sortDirection": "asc" }));
    // Cursors in the newest rows, outside them, aliases, a hidden row's id, a missing one, the typed form.
    let cursors = [
        json!("a699"), json!("a600"), json!("a650"), json!("a30"), json!("u640"), json!("s640"), json!("a5"),
        json!("a3"), json!("c350-0"), json!("nope"), json!({ "type": "item", "itemId": "a650" }),
    ];
    for cursor in cursors {
        for direction in ["desc", "asc"] {
            shapes.push(json!({ "limit": 3, "cursor": cursor, "sortDirection": direction }));
        }
    }
    // A turn filter: matching in the newest rows, matching only older ones, matching nothing; with and without a cursor.
    for turn in ["t13", "t3", "none"] {
        shapes.push(json!({ "limit": 5, "turnId": turn }));
        shapes.push(json!({ "limit": 5, "turnId": turn, "sortDirection": "asc" }));
        for cursor in ["a650", "a160"] {
            shapes.push(json!({ "limit": 5, "turnId": turn, "cursor": cursor }));
            shapes.push(json!({ "limit": 5, "turnId": turn, "cursor": cursor, "sortDirection": "asc" }));
        }
    }
    shapes
}

/// Every call shape against `threads`' views of `big`, and the sizes around the tail's boundaries.
async fn compare(label: &str, stores: &[(&str, Arc<dyn ThreadStore>)], tokens: LaneTokens) {
    let mut cases: Vec<(ThreadId, Value)> = shapes_of_big().into_iter().map(|shape| (ThreadId::from("big"), shape)).collect();
    for n in [129, 200, 201, 257] {
        for limit in [1, 128, 129, 200, 201, 256, 257] {
            cases.push((ThreadId::from(format!("n{n}").as_str()), json!({ "limit": limit })));
        }
        cases.push((ThreadId::from(format!("n{n}").as_str()), json!({ "limit": 200, "sortDirection": "asc" })));
    }
    let mut newest = 0;
    for (id, mut shape) in cases {
        shape["threadId"] = json!(id);
        let want = whole(&stores[0].1, tokens, &id, &shape).await;
        for (path, store) in stores {
            let (got, widest) = tailed(store, tokens, &id, &shape).await;
            let what = format!("{label}/{path}: {shape}");
            if shape == json!({ "threadId": "big", "limit": 1 }) {
                newest = widest;
            }
            match (&want, got) {
                (Ok(Reply::Value(want)), Ok(Reply::Value(got))) => assert_eq!(&got, want, "{what}"),
                (Err(want), Err(got)) => assert_eq!(format!("{got:?}"), format!("{want:?}"), "{what}"),
                (want, got) => panic!("{what}: {got:?} against {want:?}"),
            }
        }
    }
    // The newest row's page reads the first tail only, not the 700 rows.
    assert_eq!(newest, 128, "{label}");
}

/// The rows asked for and whether they are all the history: exactly the stored rows is all of it, one more is not.
async fn completeness(stores: &[(&str, Arc<dyn ThreadStore>)], tokens: LaneTokens) {
    for (path, store) in stores {
        for (rows, want, complete) in [(128, 128, true), (129, 128, false), (200, 200, true), (201, 200, false), (256, 256, true), (257, 256, false), (200, 201, true), (200, 1, false)] {
            let (store, thread) = (store.clone(), ThreadId::from(format!("n{rows}").as_str()));
            let (_, got, all) = tokens.interactive_io.submit(&CancellationToken::new(), move |lane| store.history_tail(lane, &thread, want)).expect("lane").await.expect("job ran").expect("tail");
            assert_eq!((got.len(), all), (want.min(rows), complete), "{path}: {want} of {rows} stored rows");
        }
    }
}

/// A page of `thread/items/list` decided from the newest rows equals the page of the whole history, for every call shape,
/// through the store's `history_tail` and the trait's default one, over a thread held open by its writer and over the same
/// thread stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_from_the_newest_rows_equals_the_page_of_the_whole_history() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let real: Arc<dyn ThreadStore> = threads.clone();
    let default: Arc<dyn ThreadStore> = Arc::new(DefaultTail(threads.clone()));
    let stores = [("store", real), ("default", default)];
    let mut live = vec![create(&threads, tokens, "big", big()).await];
    for n in [128, 129, 200, 201, 256, 257] {
        live.push(create(&threads, tokens, &format!("n{n}"), plain(n)).await);
    }
    completeness(&stores, tokens).await;
    compare("live", &stores, tokens).await;
    // The writers gone: the same threads, stored.
    drop(live);
    completeness(&stores, tokens).await;
    compare("stored", &stores, tokens).await;
}
