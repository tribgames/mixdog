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
use mixdog_store::fsio::AppendStep;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;

use super::SessionLanes;
use super::ThreadStore;
use super::Transcript;
use super::read_trace::ReadCtl;
use super::reads::items_window;
use super::reads::list_from_tail;
use super::reads::page;
use super::seams::AppendPosition;
use super::seams::BarrierError;
use super::seams::CommitRecord;
use super::seams::EncodedRecord;
use super::seams::HeldBy;
use super::seams::PageAsk;
use super::seams::PageAt;
use super::seams::PageRead;
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
    fn decode(
        &self,
        lane: &InLane<mixdog_rt::CpuInteractive>,
        id: &ThreadId,
        head: super::seams::HeadRead,
        window: super::seams::WindowRead,
    ) -> Result<super::seams::OpenedLog, CoreError> {
        self.0.decode(lane, id, head, window)
    }
    fn user_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<ItemRecord>, CoreError> {
        self.0.user_rows(lane, id)
    }
    fn history_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<(u64, Vec<ItemRecord>), CoreError> {
        self.0.history_rows(lane, id)
    }
    /// The seam's own default with the store's marks: the whole history read, then cut to its newest rows.
    fn history_tail_decor(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        rows: usize,
    ) -> Result<(u64, Vec<ItemRecord>, Vec<super::seams::RowDecor>, bool), CoreError> {
        let (rev, mut all, mut decor, _) = self.0.history_tail_decor(lane, id, usize::MAX)?;
        let complete = all.len() <= rows;
        let cut = all.len().saturating_sub(rows);
        all.drain(..cut);
        decor.drain(..cut.min(decor.len()));
        Ok((rev, all, decor, complete))
    }
    fn thread_op(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<super::seams::StoredOp>, CoreError> {
        self.0.thread_op(lane, id, op)
    }
    fn committed_op(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<super::seams::StoredOp>, CoreError> {
        self.0.committed_op(lane, id, op)
    }
    fn fenced_ops(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError> {
        self.0.fenced_ops(lane, id)
    }
    fn history_row(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<(u64, ItemRecord)>, CoreError> {
        self.0.history_row(lane, id, iid)
    }
    fn rewind_targets(
        &self,
        lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        before: Option<u64>,
        limit: usize,
    ) -> Result<(u64, Vec<mixdog_store::sqlite::rewind::RewindTarget>), CoreError> {
        self.0.rewind_targets(lane, id, before, limit)
    }
    fn rewind_target(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, shown: &str) -> Result<Option<crate::session::seams::StoredRewind>, CoreError> {
        self.0.rewind_target(lane, id, shown)
    }
    fn compaction_entry(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        self.0.compaction_entry(lane, id, iid)
    }
    fn context_io(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, read: Option<super::seams::ContextRead>) -> Result<super::seams::ContextRead, CoreError> {
        self.0.context_io(lane, id, read)
    }
    fn context_len(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<usize, CoreError> {
        self.0.context_len(lane, id)
    }
    fn context_from_io(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, skip: usize) -> Result<super::seams::ContextRead, CoreError> {
        self.0.context_from_io(lane, id, skip)
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
    fn archived_agent_parents(&self, child: &ThreadId) -> futures::future::BoxFuture<'static, Result<Vec<ThreadId>, CoreError>> {
        self.0.archived_agent_parents(child)
    }
    fn draft_write(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, write: &super::turn_draft::DraftWrite) -> Result<(), CoreError> {
        self.0.draft_write(lane, id, write)
    }
}

fn lanes(tokens: LaneTokens) -> SessionLanes {
    SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io }
}

/// The page of the whole history, as the reads built it before they read tails.
async fn whole(store: &Arc<dyn ThreadStore>, tokens: LaneTokens, id: &ThreadId, params: &Value) -> Result<Reply, CoreError> {
    let token = CancellationToken::new();
    let (thread, reading) = (id.clone(), store.clone());
    // The whole history as `reads::history` reads it: every record, marked as a page marks it.
    let (rev, records, decor, _) =
        tokens.interactive_io.submit(&token, move |lane| reading.history_tail_decor(lane, &thread, usize::MAX)).expect("lane").await.expect("job ran")?;
    let transcript = RecordTranscript::new();
    let rows = tokens
        .cpu_interactive
        .submit(&token, move |lane| {
            let mut rows: Vec<(ThreadItem, usize)> = Vec::new();
            for (at, record) in records.iter().enumerate() {
                super::reads::decorate(&mut rows, transcript.rows(lane, record), decor.get(at));
            }
            rows
        })
        .expect("lane")
        .await
        .expect("job ran");
    Ok(items_window(id, rev, &rows, true, &serde_json::from_value(params.clone()).expect("params"))?.expect("the whole history decides every page"))
}

/// The page read from the newest rows, and the most rows it read.
async fn tailed(store: &Arc<dyn ThreadStore>, tokens: LaneTokens, id: &ThreadId, params: &Value) -> (Result<Reply, CoreError>, usize) {
    let transcript: Arc<dyn Transcript> = Arc::new(RecordTranscript::new());
    let widest = std::cell::Cell::new(0);
    let ctl = ReadCtl::untraced(CancellationToken::new());
    let got = list_from_tail(id, &serde_json::from_value(params.clone()).expect("params"), |at, n| {
        if at == PageAt::Newest {
            widest.set(widest.get().max(n));
        }
        let (store, transcript, id, ctl) = (store.clone(), transcript.clone(), id.clone(), ctl.clone());
        async move { page(&store, &transcript, lanes(tokens), &id, at, n, &ctl).await }
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
        json!("a699"),
        json!("a600"),
        json!("a650"),
        json!("a30"),
        json!("u640"),
        json!("s640"),
        json!("a5"),
        json!("a3"),
        json!("c350-0"),
        json!("nope"),
        json!({ "type": "item", "itemId": "a650" }),
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

fn compare_cases() -> Vec<(ThreadId, Value)> {
    let mut cases: Vec<(ThreadId, Value)> = shapes_of_big().into_iter().map(|shape| (ThreadId::from("big"), shape)).collect();
    for n in [129, 200, 201, 257] {
        for limit in [1, 128, 129, 200, 201, 256, 257] {
            cases.push((ThreadId::from(format!("n{n}").as_str()), json!({ "limit": limit })));
        }
        cases.push((ThreadId::from(format!("n{n}").as_str()), json!({ "limit": 200, "sortDirection": "asc" })));
    }
    cases
}

async fn compare_case(
    label: &str,
    stores: &[(&str, Arc<dyn ThreadStore>)],
    tokens: LaneTokens,
    id: ThreadId,
    mut shape: Value,
) -> Result<Option<usize>, String> {
    shape["threadId"] = json!(id);
    let want = whole(&stores[0].1, tokens, &id, &shape).await;
    let mut newest = None;
    for (path, store) in stores {
        let (got, widest) = tailed(store, tokens, &id, &shape).await;
        let what = format!("{label}/{path}: {shape}");
        if shape == json!({ "threadId": "big", "limit": 1 }) {
            newest = Some(widest);
        }
        match (&want, got) {
            (Ok(Reply::Value(want)), Ok(Reply::Value(got))) if &got != want => {
                return Err(format!(
                    "{what}
  left: {got}
 right: {want}"
                ));
            }
            (Ok(Reply::Value(_)), Ok(Reply::Value(_))) => {}
            (Err(want), Err(got)) if format!("{got:?}") != format!("{want:?}") => {
                return Err(format!(
                    "{what}
  left: {got:?}
 right: {want:?}"
                ));
            }
            (Err(_), Err(_)) => {}
            (want, got) => return Err(format!("{what}: {got:?} against {want:?}")),
        }
    }
    Ok(newest)
}

/// Every call shape against `threads`' views of `big`, and the sizes around the tail's boundaries.
async fn compare(label: &str, stores: &[(&str, Arc<dyn ThreadStore>)], tokens: LaneTokens) {
    let cases = compare_cases();
    use futures::StreamExt;
    let total = cases.len();
    let outcomes: Vec<Result<Option<usize>, String>> =
        futures::stream::iter(cases).map(|(id, shape)| compare_case(label, stores, tokens, id, shape)).buffer_unordered(16).collect().await;
    eprintln!("{label}: {total} cases compared");
    let failed: Vec<&String> = outcomes.iter().filter_map(|outcome| outcome.as_ref().err()).collect();
    assert!(
        failed.is_empty(),
        "{} of {total} cases differ:
{}",
        failed.len(),
        failed.iter().map(|f| f.as_str()).collect::<Vec<_>>().join(
            "
"
        )
    );
    let newest = outcomes.iter().find_map(|outcome| outcome.as_ref().ok().copied().flatten()).expect("the newest row's case ran");
    // The newest row's page reads the first tail only, not the 700 rows.
    assert_eq!(newest, 128, "{label}");
}

/// The rows asked for and whether they are all the history: exactly the stored rows is all of it, one more is not.
async fn completeness(stores: &[(&str, Arc<dyn ThreadStore>)], tokens: LaneTokens) {
    for (path, store) in stores {
        for (rows, want, complete) in
            [(128, 128, true), (129, 128, false), (200, 200, true), (201, 200, false), (256, 256, true), (257, 256, false), (200, 201, true), (200, 1, false)]
        {
            let (store, thread) = (store.clone(), ThreadId::from(format!("n{rows}").as_str()));
            let (_, got, all) = tokens
                .interactive_io
                .submit(&CancellationToken::new(), move |lane| store.history_tail(lane, &thread, want))
                .expect("lane")
                .await
                .expect("job ran")
                .expect("tail");
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

/// A user message row (the model's own, not a display row) carrying the submission id it was sent under.
fn prompt_message(iid: &str, submission: &str, kind: &str) -> CommitRecord {
    let body = json!({ "role": "user", "content": "hi", "meta": { "transcript": { "clientSubmissionId": submission } } });
    match kind {
        "amend" => commit(json!({"k":"amend","iid":iid,"refs":[],"body":{"inline":body}})),
        _ => commit(json!({"k":"item","iid":iid,"form":"message","model":true,"visible":true,"prompt":{"inline":"hi"},"refs":[],"body":{"inline":body}})),
    }
}

/// An older user row amended to name submission `X`, which a row far newer (more than a tail's 128 records away) already
/// shows: the cursor `X` is decided by the same row as by the whole history, which takes the older amended one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cursor_naming_an_amended_older_row_and_a_newer_one_picks_the_row_the_whole_history_does() {
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
    let mut rows = vec![prompt_message("m0", "old", "item")];
    rows.extend((0..300).map(|i| assistant(i, "t0", true)));
    rows.push(user("n1", "X", "t1"));
    rows.extend((300..310).map(|i| assistant(i, "t1", true)));
    rows.push(prompt_message("m0", "X", "amend"));
    let live = create(&threads, tokens, "amended", rows).await;
    let id = ThreadId::from("amended");
    for cursor in ["X", "old", "m0", "n1", "a5"] {
        for direction in ["desc", "asc"] {
            let shape = json!({ "threadId": id, "limit": 3, "cursor": cursor, "sortDirection": direction });
            let want = whole(&stores[0].1, tokens, &id, &shape).await;
            for (path, store) in &stores {
                let (got, _) = tailed(store, tokens, &id, &shape).await;
                let what = format!("{path}: {shape}");
                match (&want, got) {
                    (Ok(Reply::Value(want)), Ok(Reply::Value(got))) => assert_eq!(&got, want, "{what}"),
                    (Err(want), Err(got)) => assert_eq!(format!("{got:?}"), format!("{want:?}"), "{what}"),
                    (want, got) => panic!("{what}: {got:?} against {want:?}"),
                }
            }
        }
    }
    drop(live);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_scan_survives_other_writes_but_rejects_unprojected_changes_to_its_own_log() {
    use mixdog_core_base::support::on_lane_wait;

    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let scanned = create(&threads, tokens, "scan-turns", plain(40)).await;
    let other = create(&threads, tokens, "other-turns", plain(1)).await;
    threads.projected().await;
    let cancel = CancellationToken::new();
    let chunk = |after| {
        let (threads, read_cancel) = (threads.clone(), cancel.clone());
        on_lane_wait(tokens.interactive_io, &cancel, move |lane| threads.turn_history_chunk(lane, &ThreadId::from("scan-turns"), after, &read_cancel))
    };
    let first = chunk(None).await.expect("job").expect("read").expect("initial chunk");
    let (held, release) = threads.hold_index();
    held.await.expect("index held");
    on_lane_wait(tokens.durability_io, &cancel, move |lane| {
        other.lock().expect("log").commit(lane, &[assistant(1, "t0", true)]).expect("unrelated write");
    })
    .await
    .expect("job");
    let result = chunk(Some(first.next.expect("more history"))).await.expect("job").expect("read");
    assert!(result.as_ref().is_some_and(|page| !page.records.is_empty()), "the unrelated write must not invalidate this scan");
    on_lane_wait(tokens.durability_io, &cancel, move |lane| {
        scanned.lock().expect("log").commit(lane, &[assistant(40, "t0", true)]).expect("same-thread write");
    })
    .await
    .expect("job");
    let stale = chunk(Some(result.expect("next chunk").next.expect("more history"))).await.expect("job").expect("read");
    assert!(stale.is_none(), "the old scan cannot continue after a same-thread write");
    assert!(chunk(None).await.expect("job").expect("read").is_none(), "an unprojected append cannot start a new scan");
    drop(release);
    threads.projected().await;
    let refreshed = chunk(None).await.expect("job").expect("read").expect("new scan");
    assert_eq!(refreshed.records.first().map(|row| row.iid.as_str()), Some("a40"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_read_at_the_read_barrier_reports_caller_cancellation() {
    use mixdog_core_api::ThreadDirectory;

    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let log = create(&threads, tokens, "cancel-turns", plain(1)).await;
    let rig = super::testing::Rig::new();
    let directory = super::SessionDirectory::new(rig.deps_on(threads.clone()));
    let (held, release) = threads.hold_index();
    held.await.expect("index held");
    // The thread's own write, acknowledged and behind the held index: what its reads wait for at the barrier.
    mixdog_core_base::support::on_lane_wait(tokens.durability_io, &CancellationToken::new(), move |lane| {
        log.lock().expect("log").commit(lane, &[assistant(1, "t0", true)]).expect("the thread's write");
    })
    .await
    .expect("job");
    let reads = [
        ("thread/turns/list", json!({"threadId": "cancel-turns", "itemsView": false})),
        ("thread/turns/list", json!({"threadId": "cancel-turns", "itemsView": true})),
        ("thread/items/list", json!({"threadId": "cancel-turns"})),
    ];
    for (method, params) in reads {
        let req = super::thread_fence_tests::request(method, params);
        let cancel = req.ctx.cancel.clone();
        let mut response = std::pin::pin!(directory.request(req));
        assert!(futures::poll!(response.as_mut()).is_pending());
        cancel.cancel();
        assert!(matches!(futures::poll!(response.as_mut()), std::task::Poll::Ready(Err(CoreError::Cancelled { by })) if by.as_ref() == "caller"));
    }
    drop(release);
    threads.projected().await;
}

/// A model message row.
fn message(iid: &str) -> CommitRecord {
    let body = json!({ "role": "assistant", "content": format!("text of {iid}") });
    commit(json!({"k":"item","iid":iid,"form":"message","model":true,"visible":true,"refs":[],"body":{"inline":body}}))
}

/// A compaction that took nothing out and kept `entries` messages of its own, as a context restart writes each turn.
fn restart(n: usize, entries: usize) -> CommitRecord {
    let kept: Vec<Value> = (0..entries).map(|i| json!({ "iid": format!("k{n}-{i}"), "body": { "role": "user", "content": "kept" } })).collect();
    commit(json!({"k":"compacted","cid":format!("c{n}"),"dropped_count":0,"silent":true,"replacement":{"inline":kept}}))
}

/// The oldest page of a long thread and the page after it (by the first page's `nextCursor`) read rows in proportion to
/// the page, and every statement those pages run on the index, counted by its connection (their revision and anchor,
/// their rows, the copies later compactions kept of them, the compactions that decide them and each one's probe, their
/// model switches and dividers), runs about as many steps however many context restarts the thread wrote after those rows:
/// a thread that restarts its context every turn holds the messages each restart kept, far more of them than it has rows.
/// Not exactly as many: the restarts after a row are still passed over, once per index page.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_newer_page_costs_its_rows_whatever_the_thread_wrote_after_them() {
    const LIMIT: usize = 50;
    const ROWS: usize = 600;
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let store: Arc<dyn ThreadStore> = threads.clone();
    let mut live = Vec::new();
    let mut over = Vec::new();
    let mut steps = Vec::new();
    for (name, restarts) in [("restarts4", 4usize), ("restarts64", 64)] {
        let mut rows: Vec<CommitRecord> = (0..ROWS).map(|i| message(&format!("m{i}"))).collect();
        rows.extend((0..restarts).map(|n| restart(n, 100)));
        live.push(create(&threads, tokens, name, rows).await);
        let id = ThreadId::from(name);
        mixdog_store::read_count::take_steps(name);
        let mut cursor: Option<String> = None;
        for call in 0..2 {
            let mut shape = json!({ "threadId": id, "limit": LIMIT, "sortDirection": "asc" });
            if let Some(cursor) = &cursor {
                shape["cursor"] = json!(cursor);
            }
            let (got, _) = tailed(&store, tokens, &id, &shape).await;
            let read = mixdog_store::read_count::take(name);
            let Reply::Value(page) = got.expect("a page") else { panic!("a value") };
            assert_eq!(page["data"].as_array().map(Vec::len), Some(LIMIT), "{name} call {call}");
            assert_eq!(page["data"][0]["id"], json!(format!("m{}", call * LIMIT)), "{name} call {call}");
            if read > (8 * LIMIT) as u64 {
                over.push(format!("{name} call {call} read {read} rows for a page of {LIMIT}"));
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
        }
        steps.push(mixdog_store::read_count::take_steps(name));
    }
    assert!(over.is_empty(), "{over:#?}");
    assert!(steps[1] <= 2 * steps[0], "the same two pages cost the index {} steps after 4 restarts and {} after 64", steps[0], steps[1]);
}

/// A model message row of a turn.
fn turn_message(iid: &str, turn: &str) -> CommitRecord {
    let body = json!({ "role": "assistant", "content": format!("text of {iid}") });
    commit(json!({"k":"item","iid":iid,"turn":turn,"form":"message","model":true,"visible":true,"refs":[],"body":{"inline":body}}))
}

/// A turn's end is shown archived only when no message of its turn is left, whichever of them the page holds: a page
/// read on from a dropped message holds that message and the turn's end, not the earlier message the compaction kept,
/// and shows the end as the whole history does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turns_end_is_archived_by_its_whole_turn_whatever_the_page_holds() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let store: Arc<dyn ThreadStore> = threads.clone();
    let kept = json!({ "iid": "s", "body": { "role": "assistant", "content": "text of s" } });
    let rows = vec![
        turn_message("s", "t1"),
        turn_message("d", "t1"),
        row("e", "t1", true, json!({ "kind": "assistant", "id": "e", "text": "the end of t1" })),
        commit(json!({"k":"compacted","cid":"c1","dropped_count":1,"replacement":{"inline":[kept]}})),
        turn_message("z", "t2"),
    ];
    let live = create(&threads, tokens, "kept-turn", rows).await;
    let id = ThreadId::from("kept-turn");
    let archived = |row: &Value| serde_json::to_string(row).expect("a row").contains("\"archived\":true");
    for (cursor, direction) in [("d", "asc"), ("s", "asc"), ("z", "desc")] {
        let shape = json!({ "threadId": id, "limit": 5, "cursor": cursor, "sortDirection": direction });
        let Ok(Reply::Value(want)) = whole(&store, tokens, &id, &shape).await else { panic!("the whole history answers {shape}") };
        let (got, _) = tailed(&store, tokens, &id, &shape).await;
        let Ok(Reply::Value(got)) = got else { panic!("a page of {shape}") };
        assert_eq!(got, want, "{shape}");
        let end = got["data"].as_array().expect("rows").iter().find(|row| row["id"] == "e").expect("the turn's end");
        assert!(!archived(end), "{shape}: {end}");
    }
    // The compaction did drop the message the forward page starts from.
    let Ok(Reply::Value(page)) = whole(&store, tokens, &id, &json!({ "threadId": id, "limit": 5, "cursor": "s", "sortDirection": "asc" })).await else {
        panic!("the whole history")
    };
    assert!(archived(&page["data"][0]), "{}", page["data"][0]);
    drop(live);
}

/// One stored page of `thread`, as its job answers it.
async fn stored_page(threads: &Arc<StoreThreads>, tokens: LaneTokens, thread: &str, at: PageAt) -> PageRead {
    let (threads, id) = (threads.clone(), ThreadId::from(thread));
    tokens
        .interactive_io
        .submit(&CancellationToken::new(), move |lane| {
            threads.history_page(lane, &id, &PageAsk { at, records: 128 }, &ReadCtl::untraced(CancellationToken::new()))
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("a page read")
}

async fn rewind(log: &Log, tokens: LaneTokens, to: u64) {
    let log = log.clone();
    LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
        log.lock().expect("log").commit(lane, &[commit(json!({"k":"rewind","to_ordinal":to,"reason":"edit"}))]).expect("appended");
    })
    .expect("lane")
    .await
    .expect("job ran");
}

/// A rewind that reaches the index after a page read looked at its revision and before it read its rows: the read gives
/// no page (its rows would be of the new history under the old revision and cut) and is asked again, and then reads the
/// rewound history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_read_a_rewind_lands_in_is_asked_again() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let log = create(&threads, tokens, "rewound-under", plain(10)).await;
    threads.projected().await;
    let (reached, at_rows) = std::sync::mpsc::channel::<()>();
    let (landed, go_on) = std::sync::mpsc::channel::<()>();
    threads.hold_page_read(move || {
        reached.send(()).expect("the test waits");
        tokio::task::block_in_place(|| go_on.recv()).expect("the rewind landed");
    });
    let rewinding = {
        let (threads, log) = (threads.clone(), log.clone());
        tokio::spawn(async move {
            tokio::task::spawn_blocking(move || at_rows.recv()).await.expect("joined").expect("the read reached its rows");
            rewind(&log, tokens, 6).await;
            threads.projected().await;
            landed.send(()).expect("the read waits");
        })
    };
    let first = stored_page(&threads, tokens, "rewound-under", PageAt::Oldest).await;
    rewinding.await.expect("the rewind");
    assert!(matches!(first, PageRead::Held(HeldBy::Index { .. })), "a page read across a rewind gave rows");
    let PageRead::Rows(page) = stored_page(&threads, tokens, "rewound-under", PageAt::Oldest).await else { panic!("the rewound history is read") };
    assert_eq!(page.records.iter().map(|record| record.iid.as_str().to_owned()).collect::<Vec<_>>(), ["a0", "a1", "a2", "a3", "a4"]);
}

/// A rewind in the log that the index has not taken: a page read gives its worker back however often it is asked, the wait
/// it names ends when the rewind's projection is answered, and the page is then of the rewound history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_behind_a_durable_rewind_waits_for_its_projection() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let log = create(&threads, tokens, "rewound-behind", plain(10)).await;
    threads.projected().await;
    let (held, release) = threads.hold_index();
    held.await.expect("index held");
    rewind(&log, tokens, 6).await;
    let mut held = None;
    for asked in 0..6 {
        match stored_page(&threads, tokens, "rewound-behind", PageAt::Newest).await {
            PageRead::Held(by @ HeldBy::Index { behind: Some(_) }) => held = Some(by),
            _ => panic!("asked {asked} times, the read did not wait for the index"),
        }
    }
    let mut settled = std::pin::pin!(threads.page_held(&held.expect("a wait")));
    assert!(futures::poll!(settled.as_mut()).is_pending(), "the rewind's projection is not answered yet");
    drop(release);
    settled.await.expect("the projection is answered");
    let PageRead::Rows(page) = stored_page(&threads, tokens, "rewound-behind", PageAt::Newest).await else { panic!("the rewound history is read") };
    assert_eq!(page.records.len(), 5);
}

type SyncHold = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);

/// A test's hold on the sync of the next batch that carries a rewind.
static REWIND_SYNC: Mutex<Option<SyncHold>> = Mutex::new(None);

/// The sync of a batch that carries a rewind, once a test holds it: said to the test, held until the test lets go, then
/// failed as a disk fails it. The rewind's frame is in the log from the write before this to the rollback after it.
fn fail_held_rewind_sync(step: AppendStep, records: &[Record]) -> std::io::Result<()> {
    if step != AppendStep::Sync || !records.iter().any(|record| matches!(record, Record::Rewind(_))) {
        return Ok(());
    }
    let Some((reached, go_on)) = REWIND_SYNC.lock().expect("hold").take() else { return Ok(()) };
    reached.send(()).expect("the test waits");
    // A test's lane job runs on the thread that submits it: the wait gives that runtime worker's tasks to another.
    tokio::task::block_in_place(|| go_on.recv()).expect("the test lets go");
    Err(std::io::Error::other("EIO: injected"))
}

/// A rewind whose frame is written and whose sync then fails: a page read meanwhile gives no page of a log that holds
/// the frame (it would be of a history no one was told exists), the wait it names ends when the append has rolled the
/// frame back, though the index was sent nothing and answers nothing, and the page is then of the history as it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_that_met_a_rewind_whose_sync_failed_answers_after_its_rollback() {
    mixdog_store::fsio::set_append_hook(fail_held_rewind_sync);
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let log = create(&threads, tokens, "rolled-back", plain(10)).await;
    threads.projected().await;
    let (reached, at_sync) = std::sync::mpsc::channel::<()>();
    let (let_go, go_on) = std::sync::mpsc::channel::<()>();
    *REWIND_SYNC.lock().expect("hold") = Some((reached, go_on));
    // On a task of its own: the append stops at its sync on the thread that submitted it.
    let rewinding = {
        let log = log.clone();
        tokio::spawn(async move {
            LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
                log.lock().expect("log").commit(lane, &[commit(json!({"k":"rewind","to_ordinal":6,"reason":"edit"}))]).is_err()
            })
            .expect("lane")
            .await
            .expect("job ran")
        })
    };
    tokio::task::spawn_blocking(move || at_sync.recv()).await.expect("joined").expect("the rewind reached its sync");
    let PageRead::Held(by) = stored_page(&threads, tokens, "rolled-back", PageAt::Newest).await else {
        panic!("a page was read from a log that holds a rewind not yet synced")
    };
    let mut wait = std::pin::pin!(threads.page_held(&by));
    assert!(futures::poll!(wait.as_mut()).is_pending(), "the rewind's append still runs: {by:?}");
    let_go.send(()).expect("the append waits");
    assert!(rewinding.await.expect("the rewind's task"), "the rewind's sync failed");
    mixdog_rt::time::timeout(std::time::Duration::from_secs(30), wait)
        .await
        .unwrap_or_else(|_| panic!("the page still waits after the rollback: {by:?}"))
        .expect("nothing stopped");
    let PageRead::Rows(page) = stored_page(&threads, tokens, "rolled-back", PageAt::Newest).await else { panic!("the history is read as it was") };
    assert_eq!(page.records.len(), 10);
    // The request's read of the same thread, through its own waits.
    let store: Arc<dyn ThreadStore> = threads.clone();
    let id = ThreadId::from("rolled-back");
    let (got, _) = tailed(&store, tokens, &id, &json!({ "threadId": id, "limit": 20 })).await;
    let Ok(Reply::Value(got)) = got else { panic!("a page") };
    assert_eq!(got["data"].as_array().map(Vec::len), Some(10));
}

/// [`create`] with `rows` committed 100 at a time, as a running session writes them, so the log carries its checkpoints.
async fn create_batched(threads: &Arc<StoreThreads>, tokens: LaneTokens, thread: &str, rows: Vec<CommitRecord>) -> Log {
    let (threads, thread) = (threads.clone(), ThreadId::from(thread));
    let session = commit(json!({"k":"session","v":2,"id":thread.as_str(),"log_id":LOG_ID,"header":{"inline":{"title":"t"}}}));
    LaneToken::submit(tokens.durability_io, &CancellationToken::new(), move |lane| {
        let (mut log, _) = threads.create_log(lane, &thread, &session).expect("created");
        for batch in rows.chunks(100) {
            log.commit(lane, batch).expect("appended");
        }
        Arc::new(Mutex::new(log))
    })
    .expect("lane")
    .await
    .expect("job ran")
}

/// A page that shows a turn's end without the turn's messages asks the index for them by the turn: with every statement
/// of the page counted, it costs about the same whether the run before that turn wrote 30 messages or 3,000, and shows
/// the end as the whole history does (archived: the compaction took the turn's one message).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_flag_of_a_turn_after_a_long_run_costs_the_turn() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let store: Arc<dyn ThreadStore> = threads.clone();
    let run = |rid: &str| commit(json!({"k":"run","rid":rid,"phase":"started","at":1}));
    let archived = |row: &Value| serde_json::to_string(row).expect("a row").contains("\"archived\":true");
    let mut live = Vec::new();
    let mut steps = Vec::new();
    for (name, long) in [("after-run-30", 30usize), ("after-run-3000", 3000)] {
        // A turn's first message precedes its run's start.
        let mut rows = vec![turn_message("m0", "t1"), run("t1")];
        rows.extend((1..long).map(|i| turn_message(&format!("m{i}"), "t1")));
        rows.extend([
            turn_message("d", "t2"),
            run("t2"),
            row("e", "t2", true, json!({ "kind": "assistant", "id": "e", "text": "the end of t2" })),
            commit(json!({"k":"compacted","cid":"c1","dropped_count":long + 1,
                "replacement":{"inline":[{"iid":"sum","body":{"role":"user","content":"summary"}}]}})),
            turn_message("z", "t3"),
        ]);
        live.push(create_batched(&threads, tokens, name, rows).await);
        let id = ThreadId::from(name);
        // Read on from the turn's dropped message: the page holds the turn's end and no message of the turn left.
        let shape = json!({ "threadId": id, "limit": 5, "cursor": "d", "sortDirection": "asc" });
        let Ok(Reply::Value(want)) = whole(&store, tokens, &id, &shape).await else { panic!("the whole history answers {name}") };
        mixdog_store::read_count::take_steps(name);
        let (got, _) = tailed(&store, tokens, &id, &shape).await;
        steps.push(mixdog_store::read_count::take_steps(name));
        let Ok(Reply::Value(got)) = got else { panic!("a page of {name}") };
        assert_eq!(got, want, "{name}");
        let end = got["data"].as_array().expect("rows").iter().find(|row| row["id"] == "e").expect("the turn's end");
        assert!(archived(end), "{name}: {end}");
    }
    assert!(steps[0] > 0, "the page's statements are counted");
    assert!(steps[1] <= 2 * steps[0], "the same page cost the index {} steps after a run of 30 messages and {} after one of 3,000", steps[0], steps[1]);
    drop(live);
}

/// A row of a long session: about 300 bytes of text; every 25th row a user prompt, a new turn every 20 rows.
fn long_row(i: usize) -> CommitRecord {
    let turn = format!("t{}", i / 20);
    if i % 25 == 0 {
        return user(&format!("u{i}"), &format!("s{i}"), &turn);
    }
    let id = format!("a{i}");
    row(&id, &turn, true, json!({ "kind": "assistant", "id": id, "text": format!("{i} {}", "lorem ipsum dolor sit amet ".repeat(11)) }))
}

/// Opening a long session (the newest page) and paging back through it (three older pages, each by the previous page's
/// `nextCursor`) reads rows in proportion to the page, not to the session: the rows the store reads from its index and
/// from the log are counted per call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opening_and_paging_a_long_history_reads_rows_in_proportion_to_the_page() {
    const LIMIT: usize = 50;
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let threads = Arc::new(
        StoreThreads::over_data_dir(data.path(), index_over(data.path(), tokens).await, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let store: Arc<dyn ThreadStore> = threads.clone();
    let mut live = Vec::new();
    let mut over = Vec::new();
    for total in [1_000usize, 14_000] {
        let name = format!("long{total}");
        live.push(create_batched(&threads, tokens, &name, (0..total).map(long_row).collect()).await);
        let id = ThreadId::from(name.as_str());
        let mut cursor: Option<String> = None;
        for call in 0..4 {
            let mut shape = json!({ "threadId": id, "limit": LIMIT });
            if let Some(cursor) = &cursor {
                shape["cursor"] = json!(cursor);
            }
            let (got, _) = tailed(&store, tokens, &id, &shape).await;
            let read = mixdog_store::read_count::take(&name);
            let Reply::Value(page) = got.expect("a page") else { panic!("a value") };
            assert_eq!(page["data"].as_array().map(Vec::len), Some(LIMIT), "{name} call {call}");
            if read > (8 * LIMIT) as u64 {
                over.push(format!("{name} call {call} read {read} rows for a page of {LIMIT}"));
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
        }
    }
    assert!(over.is_empty(), "{over:#?}");
}
