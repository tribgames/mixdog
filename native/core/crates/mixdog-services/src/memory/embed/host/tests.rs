use super::*;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::model_host::ChildExit;
use tokio::io::AsyncReadExt;

const BODY: &str = "memory::embed::host::tests::host_process_body";
const MODE: &str = "MIXDOG_TEST_EMBED_HOST";
const REPORT: &str = "MIXDOG_TEST_EMBED_REPORT";
const LIMIT: Duration = Duration::from_secs(60);

struct Scripted;
impl Metadata for Scripted {
    fn dims(&self) -> usize {
        3
    }
    fn device(&self) -> &'static str {
        "cpu"
    }
}

fn test_launch(mode: &str) -> HostLaunch {
    HostLaunch {
        program: std::env::current_exe().unwrap(),
        args: ["--exact", BODY, "--nocapture", "--test-threads=1"].map(Into::into).to_vec(),
        env: vec![(MODE.to_owned(), mode.to_owned())],
    }
}

pub(super) fn real_launch(config: &EmbedConfig) -> HostLaunch {
    let mut launch = test_launch("real");
    launch.env.extend([
        ("MIXDOG_TEST_EMBED_CACHE".into(), config.cache_dir.to_string_lossy().into_owned()),
        ("MIXDOG_TEST_EMBED_LIBRARY".into(), config.ort_library.to_string_lossy().into_owned()),
        ("MIXDOG_TEST_EMBED_MODEL".into(), config.model_id.clone()),
        ("MIXDOG_TEST_EMBED_DTYPE".into(), config.dtype.clone().unwrap_or_default()),
    ]);
    launch
}

#[tokio::test(flavor = "multi_thread")]
async fn host_process_body() {
    let Ok(mode) = std::env::var(MODE) else { return };
    crate::effort_judge::host::end_with_parent();
    if let Ok(address) = std::env::var(REPORT) {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        // The pid, then whether this process started below normal priority, read at the first moment it can: a
        // machine-wide sweep may raise the class of a host later (see `the_host_runs_below_normal_priority`).
        let below = crate::memory::tests::fakes::below_normal(std::process::id());
        stream.write_all(&std::process::id().to_le_bytes()).unwrap();
        stream.write_all(&[u8::from(below)]).unwrap();
        // Windows can reset a killed child's connection before the parent
        // reads buffered bytes. Do not serve requests until it has the report.
        let mut ack = [0];
        stream.read_exact(&mut ack).unwrap();
        assert_eq!(ack, [1]);
    }
    let tokens = mixdog_rt::testing::tokens();
    let code = if mode == "real" {
        let get = |name| std::env::var(name).unwrap();
        let dtype = get("MIXDOG_TEST_EMBED_DTYPE");
        let config = EmbedConfig {
            cache_dir: get("MIXDOG_TEST_EMBED_CACHE").into(),
            ort_library: get("MIXDOG_TEST_EMBED_LIBRARY").into(),
            model_id: get("MIXDOG_TEST_EMBED_MODEL"),
            dtype: (!dtype.is_empty()).then_some(dtype),
            sessions: 1,
            lane: tokens.cpu_bulk,
        };
        // The production host runs outside a runtime; this harness has one.
        tokio::task::block_in_place(|| serve(config, &tokio::runtime::Handle::current(), std::io::stdin().lock(), std::io::stdout().lock()))
    } else if mode == "silent" {
        std::thread::sleep(Duration::from_secs(3600));
        0
    } else {
        serve_model(
            || {
                assert_capped_while_loading();
                Ok(Scripted)
            },
            |_, request| {
                if request.text == "crash" {
                    std::process::exit(19);
                }
                if request.text == "quit" {
                    std::process::exit(0);
                }
                if request.text == "cores" {
                    return Ok(Arc::new(vec![affinity_cores() as f32]));
                }
                if request.text == "hang" {
                    std::thread::sleep(Duration::from_secs(3600));
                }
                Ok(Arc::new(vec![request.text.len() as f32, if request.query { 1.0 } else { 0.0 }, 0.25]))
            },
            std::io::stdin().lock(),
            std::io::stdout().lock(),
        )
    };
    std::process::exit(code);
}

/// The number of cores this process may run on (Windows; elsewhere the host never caps its load).
#[cfg(windows)]
fn affinity_cores() -> u32 {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessAffinityMask};
    let (mut held, mut system) = (0usize, 0usize);
    // SAFETY: the current process's pseudo handle and two out-parameters.
    assert_ne!(unsafe { GetProcessAffinityMask(GetCurrentProcess(), &mut held, &mut system) }, 0);
    held.count_ones()
}

#[cfg(not(windows))]
fn affinity_cores() -> u32 {
    0
}
/// Run by the child as its load: a host that could use several cores has one while it loads (Node's `LOAD_AFFINITY_CORES`).
fn assert_capped_while_loading() {
    if cfg!(windows) && std::thread::available_parallelism().map_or(1, usize::from) > 1 && affinity_cores() != 1 {
        std::process::exit(41);
    }
}

struct Fixture {
    provider: Arc<EmbeddingProvider>,
    reports: Reports,
    exits: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<ChildExit>>,
    loads: Arc<std::sync::atomic::AtomicUsize>,
    _cache: tempfile::TempDir,
}

type Report = (u32, bool);

struct Reports {
    inbox: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<std::io::Result<Report>>>,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for Reports {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

async fn fixture() -> Fixture {
    fixture_with(Limits::NODE).await
}

async fn fixture_with(limits: Limits) -> Fixture {
    fixture_for(config::DEFAULT_MODEL_ID, limits, None).await
}

async fn fixture_for(model_id: &str, limits: Limits, held_load: Option<(usize, Arc<tokio::sync::Notify>)>) -> Fixture {
    let cache = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = EmbedConfig {
        model_id: model_id.to_owned(),
        cache_dir: cache.path().to_owned(),
        ort_library: "unused".into(),
        dtype: None,
        sessions: 1,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    };
    let mut launch = test_launch("scripted");
    launch.env.push((REPORT.into(), listener.local_addr().unwrap().to_string()));
    let (send, inbox) = tokio::sync::mpsc::unbounded_channel();
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        loop {
            let report = async {
                let (mut stream, _) = listener.accept().await?;
                let pid = stream.read_u32_le().await?;
                let below = stream.read_u8().await? == 1;
                stream.write_all(&[1]).await?;
                Ok((pid, below))
            }
            .await;
            let failed = report.is_err();
            if send.send(report).is_err() || failed {
                break;
            }
        }
    });
    let reports = Reports { inbox: tokio::sync::Mutex::new(inbox), reader };
    let (launched, exits) = tokio::sync::mpsc::unbounded_channel();
    let loads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = loads.clone();
    let provider = Arc::new(EmbeddingProvider::installed_model_with_load(cache.path(), model_id, move || {
        let launch_index = counted.fetch_add(1, Ordering::SeqCst);
        let gate = held_load.as_ref().filter(|(index, _)| *index == launch_index).map(|(_, gate)| gate.clone());
        let (config, launch) = (config.clone(), launch.clone());
        let launched = launched.clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            let model = Embedder::start_within(config, launch, limits).await.map_err(|e| e.message())?;
            let _ = launched.send(model.inner.pipes.child_exit.clone());
            Ok(model)
        })
    }));
    Fixture { provider, reports, exits: tokio::sync::Mutex::new(exits), loads, _cache: cache }
}

async fn peer(f: &Fixture) -> (ChildExit, u64) {
    let (child, _, _) = peer_reporting(f).await;
    let generation = child.generation;
    (child, generation)
}

/// [`peer`], and whether the host reported that it started below normal priority.
async fn peer_reporting(f: &Fixture) -> (ChildExit, u32, bool) {
    let (pid, below) = mixdog_rt::time::timeout(LIMIT, async { f.reports.inbox.lock().await.recv().await })
        .await
        .expect("child report deadline")
        .expect("child reporter ended")
        .expect("read child report");
    let child = mixdog_rt::time::timeout(LIMIT, async { f.exits.lock().await.recv().await }).await.expect("host start deadline").expect("child exit observer");
    assert_ne!(pid, std::process::id(), "inference belongs to a child");
    assert_eq!(pid, child.pid, "report belongs to the launched child");
    (child, pid, below)
}

async fn ended(child: &mut ChildExit) -> std::process::ExitStatus {
    mixdog_rt::time::timeout(LIMIT, child.wait()).await.expect("host exits")
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_are_answered_by_the_child_and_drop_ends_it() {
    let f = fixture().await;
    assert!(!f.provider.is_ready());
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f).await;
    assert_eq!(model.embed("hello", InputType::Query).await.unwrap().as_slice(), [5.0, 1.0, 0.25]);
    let batch = model.embed_batch(&["a".into(), "xyz".into()], InputType::Document).await.unwrap();
    assert_eq!(batch[0].as_slice(), [1.0, 0.0, 0.25]);
    assert_eq!(batch[1].as_slice(), [3.0, 0.0, 0.25]);
    drop(model);
    drop(f);
    ended(&mut stream).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn admitted_vectors_share_a_child_then_it_exits_before_cache_hits_and_restarts_on_a_miss() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let f = fixture_for(config::DEFAULT_MODEL_ID, Limits::NODE, Some((0, gate.clone()))).await;
    assert!(f.provider.embed_documents(Vec::new()).await.unwrap().is_empty());
    assert_eq!(f.provider.embed_query("   ").await.unwrap(), None);
    assert_eq!(f.provider.info()["dimensions"], 384);
    assert_eq!(f.loads.load(Ordering::SeqCst), 0);

    let first = f.provider.embed_query("hello");
    let second = f.provider.embed_documents(vec!["document".into()]);
    tokio::pin!(first, second);
    assert!(futures::poll!(&mut first).is_pending());
    assert!(futures::poll!(&mut second).is_pending());
    gate.notify_one();
    let (mut stream, _) = peer(&f).await;
    assert_eq!(first.await.unwrap().unwrap(), [5.0, 1.0, 0.25]);
    assert_eq!(second.await.unwrap()[0].as_slice(), [8.0, 0.0, 0.25]);
    ended(&mut stream).await;
    assert!(!f.provider.is_ready());
    assert_eq!(f.provider.embed_query("hello").await.unwrap().unwrap(), [5.0, 1.0, 0.25]);
    assert_eq!(f.loads.load(Ordering::SeqCst), 1);

    assert_eq!(f.provider.embed_query("unseen").await.unwrap().unwrap(), [6.0, 1.0, 0.25]);
    let (mut new_stream, _) = peer(&f).await;
    ended(&mut new_stream).await;
    assert_eq!(f.loads.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_custom_schema_stays_cold_until_queued_indexing_then_reuses_vectors() {
    use crate::memory::ingest::embed_flush::RawEmbedFlush;
    use crate::memory::pg::db::Schema;
    use crate::memory::recall::readiness::RecallEmbedder;
    use crate::memory::schema::{DIMS_KEY, ensure_memory_schema_with_dims, get_meta};
    use crate::memory::tests::support::TestPg;

    if !crate::tool_state::onnx_runtime_supported() {
        return;
    }
    let model_id = "acme/custom";
    let identity = config::identity(None, model_id, None);
    let f = fixture_for(model_id, Limits::NODE, None).await;
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema_with_dims(&db, None, &identity).await.unwrap();
    assert_eq!(get_meta(&db, DIMS_KEY).await.unwrap(), Some(serde_json::Value::Null));
    let status = crate::memory::status::status(&db, 0).await;
    assert!(status.text.contains("embedding_index: pending"));
    let flush = RawEmbedFlush::new(db.clone(), Some(f.provider.clone()));
    assert_eq!(flush.flush(32, None).await.attempted, 0);

    let add = |source: &'static str| {
        let db = db.clone();
        async move {
            db.execute(
                "INSERT INTO entries(ts, role, content, source_ref, session_id)
                 SELECT 1, 'user', 'an actual record ' || n, $1::text || n, 'session'
                 FROM generate_series(1, 200) AS n",
                &[&source],
            )
            .await
            .unwrap();
        }
    };
    assert_eq!(f.loads.load(Ordering::SeqCst), 0);
    add("first").await;
    assert_eq!(flush.flush(200, None).await.embedded, 200);
    let (mut child, indexing_generation) = peer(&f).await;
    ended(&mut child).await;
    assert_eq!(f.loads.load(Ordering::SeqCst), 1, "the whole queue drained on one child");
    assert_eq!(get_meta(&db, DIMS_KEY).await.unwrap(), Some(serde_json::json!(3)));
    let status = crate::memory::status::status(&db, 0).await;
    assert!(status.text.contains("embedding_index: exact-only dims=3"));

    add("same text").await;
    assert_eq!(flush.flush(200, None).await.embedded, 200);
    assert_eq!(f.loads.load(Ordering::SeqCst), 1, "the persisted cache hit did not load a model");
    let recall = RecallEmbedder::new(f.provider.clone(), false).with_schema(db.clone());
    let vector = recall.query_vector_with_wait("unrelated wording", &tokio_util::sync::CancellationToken::new(), LIMIT).await.unwrap().unwrap();
    let (mut child, recall_generation) = peer(&f).await;
    assert_ne!(indexing_generation, recall_generation);
    ended(&mut child).await;
    assert_eq!(f.loads.load(Ordering::SeqCst), 2, "the cold semantic query actually computed its vector");
    let literal = crate::memory::recall::hybrid::embedding_to_sql(&vector);
    let check =
        || async { db.query("SELECT count(*) FROM entries WHERE (embedding <=> $1::text::halfvec) < 0.1", &[&literal]).await.unwrap()[0].get::<_, i64>(0) };
    assert_eq!(check().await, 400, "semantic distance works before the column is tightened");
    ensure_memory_schema_with_dims(&db, None, &identity).await.unwrap();
    assert_eq!(check().await, 400, "cold schema reopening retained the custom vectors");
    let status = crate::memory::status::status(&db, 0).await;
    assert!(status.text.contains("embedding_index: ready dims=3"));
    assert_eq!(f.loads.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn root_reindex_retires_after_a_full_final_claim_and_picks_up_late_visible_work() {
    use crate::memory::ingest::embed_flush::{ClaimSeam, RawEmbedFlush};
    use crate::memory::pg::db::Schema;
    use crate::memory::schema::ensure_memory_schema_with_dims;
    use crate::memory::tests::support::TestPg;
    use tokio_util::sync::CancellationToken;

    if !crate::tool_state::onnx_runtime_supported() {
        return;
    }
    let model_id = "acme/root-queue";
    let f = fixture_for(model_id, Limits::NODE, None).await;
    let pg = TestPg::start().await;
    let db = pg.db(Schema::Memory).await;
    let identity = config::identity(None, model_id, None);
    ensure_memory_schema_with_dims(&db, None, &identity).await.unwrap();
    let flush = Arc::new(RawEmbedFlush::new(db.clone(), Some(f.provider.clone())));
    let cancel = CancellationToken::new();
    // A producer can reserve an older id and publish it after this pass's lookahead.
    let reserved: i64 = db.query("SELECT nextval(pg_get_serial_sequence('entries', 'id'))", &[]).await.unwrap()[0].get(0);
    let locked: i64 = db
        .query(
            "INSERT INTO entries(ts, role, content, source_ref, session_id, is_root, summary)
         VALUES (0, 'user', '', 'locked-root', 'roots', 1, 'another worker owns this') RETURNING id",
            &[],
        )
        .await
        .unwrap()[0]
        .get(0);
    let locker = db.client().await.unwrap();
    locker.batch_execute("BEGIN").await.unwrap();
    locker.query_one("SELECT id FROM entries WHERE id = $1 FOR UPDATE", &[&locked]).await.unwrap();
    let add = |source: &'static str| {
        let db = db.clone();
        async move {
            db.execute(
                "INSERT INTO entries(ts, role, content, source_ref, session_id, is_root, summary)
                 SELECT n, 'user', '', $1::text || n, 'roots', 1, 'root summary ' || n
                 FROM generate_series(1, 64) AS n",
                &[&source],
            )
            .await
            .unwrap();
        }
    };
    add("first-").await;
    let (entered, mut writing) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    flush.hold_before_final_cache_write(ClaimSeam { entered, release: release.clone() });
    let pass = {
        let flush = flush.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move { flush.flush_roots(&cancel).await })
    };
    mixdog_rt::time::timeout(LIMIT, writing.recv()).await.expect("final claim computed").expect("cache write reached");
    let (mut child, first_generation) = peer(&f).await;
    ended(&mut child).await;
    assert!(!pass.is_finished(), "the final cache write is still blocked");
    assert_eq!(f.loads.load(Ordering::SeqCst), 1, "both full claims shared one child");
    db.execute(
        "INSERT INTO entries(id, ts, role, content, source_ref, session_id, is_root, summary)
         VALUES ($1, 0, 'user', '', 'late-root', 'roots', 1, 'late uncached root')",
        &[&reserved],
    )
    .await
    .unwrap();
    release.add_permits(1);
    let pass = pass.await.unwrap().unwrap();
    assert_eq!((pass.attempted, pass.succeeded, pass.failed, pass.timed_out), (65, 65, vec![], false));
    let (mut child, next_generation) = peer(&f).await;
    assert_ne!(first_generation, next_generation);
    ended(&mut child).await;
    assert_eq!(f.loads.load(Ordering::SeqCst), 2, "the late uncached root needed its own child");

    add("cached-").await;
    let pass = flush.flush_roots(&cancel).await.unwrap();
    assert_eq!((pass.attempted, pass.succeeded, pass.failed, pass.timed_out), (64, 64, vec![], false));
    assert_eq!(f.loads.load(Ordering::SeqCst), 2, "the all-cache-hit pass started no child");
    locker.batch_execute("ROLLBACK").await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn recall_after_a_ready_child_retires_still_bounds_its_cold_wait() {
    if !crate::tool_state::onnx_runtime_supported() {
        return;
    }
    let gate = Arc::new(tokio::sync::Notify::new());
    let f = fixture_for(config::DEFAULT_MODEL_ID, Limits::NODE, Some((1, gate.clone()))).await;
    let recall = crate::memory::recall::readiness::RecallEmbedder::new(f.provider.clone(), false);
    let cancel = tokio_util::sync::CancellationToken::new();
    let ready = f.provider.warmup().await.unwrap().unwrap();
    let (mut first, first_generation) = peer(&f).await;
    assert!(ready.alive());
    assert!(recall.query_vector_with_wait("first", &cancel, Duration::ZERO).await.unwrap().is_some());
    ended(&mut first).await;
    tokio::time::pause();
    let wait = Duration::from_secs(3);
    let query = recall.query_vector_with_wait("hello", &cancel, wait);
    tokio::pin!(query);
    assert!(futures::poll!(&mut query).is_pending());
    tokio::time::advance(wait).await;
    assert_eq!(query.await.unwrap(), None, "recall can proceed with lexical results");
    tokio::time::resume();
    gate.notify_one();
    let (mut child, next_generation) = peer(&f).await;
    assert_ne!(first_generation, next_generation);
    ended(&mut child).await;
    let cached = recall.query_vector_with_wait("hello", &cancel, Duration::ZERO).await.unwrap();
    assert_eq!(cached.unwrap(), [5.0, 1.0, 0.25]);
    assert_eq!(f.loads.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_backs_off_but_a_recovered_child_retires_without_penalizing_the_next_request() {
    let f = fixture().await;
    let failure = mixdog_rt::time::timeout(LIMIT, f.provider.embed_query("crash")).await.expect("no hang").unwrap_err();
    let (mut stream, first) = peer(&f).await;
    assert!(failure.contains("host exited"), "{failure}");
    assert!(!ended(&mut stream).await.success(), "the child crashed");
    assert!(!f.provider.is_ready());
    // Put the last launch inside the backoff, independently of the child's startup time.
    f.provider.stamp_launch_now();
    let refused = f.provider.embed_query("hello").await.unwrap_err();
    assert!(refused.contains("restart backoff"), "{refused}");
    f.provider.backdate_launch(Duration::from_secs(1));
    assert_eq!(f.provider.embed_query("hello").await.unwrap().unwrap(), [5.0, 1.0, 0.25]);
    let (mut new_stream, second) = peer(&f).await;
    assert_ne!(first, second);
    ended(&mut new_stream).await;

    f.provider.stamp_launch_now();
    assert_eq!(f.provider.embed_query("unseen").await.unwrap().unwrap(), [6.0, 1.0, 0.25]);
    let (mut third_stream, third) = peer(&f).await;
    assert_ne!(second, third);
    ended(&mut third_stream).await;
}

/// A loaded host that does not answer is ended once its request limit passes instead of holding the exchange for good (the limit is shortened here), and the
/// next request starts another host.
#[tokio::test(flavor = "multi_thread")]
async fn a_host_that_never_answers_is_ended_at_its_request_limit_and_the_next_request_starts_another() {
    let f = fixture_with(Limits::new(LIMIT, Duration::from_millis(300))).await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, first) = peer(&f).await;
    let began = std::time::Instant::now();
    let failure = mixdog_rt::time::timeout(LIMIT, model.embed("hang", InputType::Document)).await.expect("no hang").unwrap_err();
    assert!(failure.message().contains("request timed out after 300ms"), "{failure}");
    assert!(began.elapsed() >= Duration::from_millis(300), "not before the limit");
    ended(&mut stream).await;
    assert!(!f.provider.is_ready());
    // The host's end counts toward the restart backoff.
    f.provider.stamp_launch_now();
    assert!(f.provider.warmup().await.err().expect("refused during the backoff").contains("restart backoff"));
    f.provider.backdate_launch(Duration::from_secs(1));
    let next = f.provider.warmup().await.unwrap().unwrap();
    let (mut new_stream, second) = peer(&f).await;
    assert_ne!(first, second);
    assert_eq!(next.embed("hello", InputType::Query).await.unwrap().as_slice(), [5.0, 1.0, 0.25]);
    drop((model, next, f));
    ended(&mut new_stream).await;
}

/// A host that is still loading is given the cold limit, not the shorter limit of a request: with a cold limit of 600 ms and a request limit of 100 ms the silent host
/// is still waited for past 100 ms and is ended by 600 ms.
#[tokio::test(flavor = "multi_thread")]
async fn a_host_still_loading_is_given_the_cold_limit_not_the_request_limit() {
    let cache = tempfile::tempdir().unwrap();
    let config = EmbedConfig {
        model_id: config::DEFAULT_MODEL_ID.to_owned(),
        cache_dir: cache.path().to_owned(),
        ort_library: "unused".into(),
        dtype: None,
        sessions: 1,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    };
    let began = std::time::Instant::now();
    let failure = mixdog_rt::time::timeout(
        LIMIT,
        Embedder::start_within(config, test_launch("silent"), Limits::new(Duration::from_millis(600), Duration::from_millis(100))),
    )
    .await
    .expect("no hang")
    .err()
    .expect("a silent host never loads");
    assert!(began.elapsed() >= Duration::from_millis(600), "ended at {:?} ({failure})", began.elapsed());
}
/// The host runs below normal priority, as Node's memory process did. The host reports its own class when it starts: a
/// class read from outside later is not the one it was started with on a machine whose tooling raises below-normal
/// processes (a sweep that raises a below-normal process whose command line names the build directory to normal).
#[tokio::test(flavor = "multi_thread")]
async fn the_host_runs_below_normal_priority() {
    let f = fixture().await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, pid, below) = peer_reporting(&f).await;
    assert!(below, "the host process {pid} started at: {}", crate::memory::tests::fakes::priority_report(pid));
    drop((model, f));
    ended(&mut stream).await;
}

/// A host loads on one core and has all its cores again once loaded (the child exits 41 when its load ran on several).
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn the_host_loads_on_one_core_and_infers_on_all_of_them() {
    let f = fixture().await;
    let model = f.provider.warmup().await.expect("the load ran on one core").unwrap();
    let (mut stream, _) = peer(&f).await;
    assert_eq!(model.embed("cores", InputType::Document).await.unwrap()[0], affinity_cores() as f32);
    drop((model, f));
    ended(&mut stream).await;
}
/// A late alarm of a finished exchange does nothing: the identity it was armed for is no longer the armed one, so it cannot kill the host a later exchange uses.
#[tokio::test(flavor = "multi_thread")]
async fn an_alarm_of_a_finished_exchange_cannot_kill_the_next_one() {
    let f = fixture().await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (_stream, _) = peer(&f).await;
    model.embed("one", InputType::Document).await.unwrap();
    // The first exchange's timer callback was dispatched before its reply returned and runs now, during no exchange and then during the second.
    model.inner.expire(1);
    assert!(model.alive());
    let second = model.embed("two", InputType::Document);
    model.inner.expire(1);
    assert_eq!(second.await.unwrap().as_slice(), [3.0, 0.0, 0.25]);
    assert!(model.alive());
}

/// Waits until `count` holders share `model` (the cell, the test, and callers parked on its end): a barrier on observed state, not a sleep.
async fn holders(model: &Embedder, count: usize) {
    mixdog_rt::time::timeout(LIMIT, async {
        while Arc::strong_count(&model.inner) < count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the warmups reached the host's end");
}

fn concurrent_warmups(f: &Arc<Fixture>, n: usize) -> Vec<tokio::task::JoinHandle<Result<Option<u64>, String>>> {
    (0..n)
        .map(|_| {
            let f = f.clone();
            tokio::spawn(async move { f.provider.warmup().await.map(|model| model.map(|model| model.generation())) })
        })
        .collect()
}

/// Rule B: a host whose output closed is `Stopping`, never classified. With the reaper's publication withheld, two concurrent warmups neither count nor
/// replace the host; once the reaper publishes exit 0, its end is accounted exactly once (the count resets) and one new host serves both.
#[tokio::test(flavor = "multi_thread")]
async fn an_eof_is_not_an_exit_and_a_clean_exit_is_accounted_once_by_concurrent_warmups() {
    let f = Arc::new(fixture().await);
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f).await;
    f.provider.set_restart_count(3);
    let withheld = model.inner.pipes.end_gate.clone().try_acquire_owned().expect("the reaper's gate is free");
    let _ = model.embed("quit", InputType::Query).await;
    ended(&mut stream).await;
    assert!(matches!(model.lifecycle(), Lifecycle::Stopping), "EOF makes the host stopping, not ended");
    let before = f.provider.accountings();
    let warmups = concurrent_warmups(&f, 2);
    // The cell, this test and both warmups parked on the end.
    holders(&model, 4).await;
    assert_eq!((f.provider.restart_count(), f.provider.accountings()), (3, before), "nothing is counted before the reaper publishes");
    assert_eq!(f.provider.held_generation(), Some(model.generation()), "nothing replaces the stopping host");
    drop(withheld);
    let mut served = Vec::new();
    for warmup in warmups {
        served.push(warmup.await.unwrap().expect("a new host loads").expect("installed"));
    }
    assert_eq!((f.provider.restart_count(), f.provider.accountings()), (0, before + 1), "the clean exit reset the count exactly once");
    assert_eq!(served[0], served[1], "both callers share the one new host");
    assert_ne!(served[0], model.generation());
    let (mut next_stream, _) = peer(&f).await;
    drop((model, f));
    ended(&mut next_stream).await;
}

/// A non-zero exit adds one, once, however many warmups meet it.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_exit_is_accounted_once_by_concurrent_warmups() {
    let f = Arc::new(fixture().await);
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f).await;
    let withheld = model.inner.pipes.end_gate.clone().try_acquire_owned().expect("the reaper's gate is free");
    let _ = model.embed("crash", InputType::Query).await;
    ended(&mut stream).await;
    let before = f.provider.accountings();
    // The next launch is inside the backoff the failure starts, so no host launches in this test.
    f.provider.stamp_launch_now();
    let warmups = concurrent_warmups(&f, 2);
    holders(&model, 4).await;
    assert_eq!((f.provider.restart_count(), f.provider.accountings()), (0, before));
    drop(withheld);
    for warmup in warmups {
        let refused = warmup.await.unwrap().err().expect("refused during the backoff");
        assert!(refused.contains("restart backoff"), "{refused}");
    }
    assert_eq!((f.provider.restart_count(), f.provider.accountings()), (1, before + 1));
}

/// A retired host (disposed by its owner) is not counted, and its later end never discards the host that replaced it.
#[tokio::test(flavor = "multi_thread")]
async fn a_retired_host_is_not_counted_and_its_end_never_discards_the_replacement() {
    let f = fixture().await;
    let old = f.provider.warmup().await.unwrap().unwrap();
    let (_old_stream, _) = peer(&f).await;
    f.provider.set_restart_count(2);
    // Past the backoff the count asks for, so the replacement launches at once.
    f.provider.backdate_launch(Duration::from_secs(60));
    let before = f.provider.accountings();
    f.provider.dispose();
    let next = f.provider.warmup().await.unwrap().unwrap();
    let (mut next_stream, _) = peer(&f).await;
    assert!(matches!(old.ended().await, Lifecycle::Ended { retired: true, .. }), "the disposal retired the old host");
    let again = f.provider.warmup().await.unwrap().unwrap();
    assert_eq!(again.generation(), next.generation(), "the old host's end left its replacement in place");
    assert_eq!((f.provider.restart_count(), f.provider.accountings()), (2, before), "a retired end counts nothing");
    drop((old, next, again, f));
    ended(&mut next_stream).await;
}

/// A host that exited by itself with status zero resets the restart count (Node's `exit` with code 0); a host that was killed adds one, and a request answered
/// does not reset it.
#[tokio::test(flavor = "multi_thread")]
async fn only_a_clean_exit_of_the_host_resets_the_restart_backoff() {
    let f = fixture().await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f).await;
    f.provider.set_restart_count(3);
    model.embed("hello", InputType::Query).await.unwrap();
    assert_eq!(f.provider.restart_count(), 3, "an answered request does not reset the count");
    let _ = model.embed("quit", InputType::Query).await;
    ended(&mut stream).await;
    assert!(matches!(model.ended().await, Lifecycle::Ended { exit: Ok(status), retired: false, .. } if status.success()));
    f.provider.stamp_launch_now();
    f.provider.backdate_launch(Duration::from_secs(60));
    let next = f.provider.warmup().await.unwrap().unwrap();
    assert_eq!(f.provider.restart_count(), 0, "the clean exit reset it");
    drop((model, next, f));
}
