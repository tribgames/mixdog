use super::*;
use crate::memory::embed::provider::EmbeddingProvider;
use tokio::io::AsyncReadExt;

const BODY: &str = "memory::embed::host::tests::host_process_body";
const MODE: &str = "MIXDOG_TEST_EMBED_HOST";
const REPORT: &str = "MIXDOG_TEST_EMBED_REPORT";
const LIMIT: Duration = Duration::from_secs(60);

struct Scripted;
impl Metadata for Scripted {
    fn dims(&self) -> usize { 3 }
    fn device(&self) -> &'static str { "cpu" }
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
    let _report = std::env::var(REPORT).ok().map(|address| {
        use std::io::Write;
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        // The pid, then whether this process started below normal priority, read at the first moment it can: a
        // machine-wide sweep may raise the class of a host later (see `the_host_runs_below_normal_priority`).
        let below = crate::memory::tests::fakes::below_normal(std::process::id());
        stream.write_all(&std::process::id().to_le_bytes()).unwrap();
        stream.write_all(&[u8::from(below)]).unwrap();
        stream
    });
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
        serve_model(|| { assert_capped_while_loading(); Ok(Scripted) }, |_, request| {
            if request.text == "crash" { std::process::exit(19); }
            if request.text == "quit" { std::process::exit(0); }
            if request.text == "cores" { return Ok(Arc::new(vec![affinity_cores() as f32])); }
            if request.text == "hang" { std::thread::sleep(Duration::from_secs(3600)); }
            Ok(Arc::new(vec![request.text.len() as f32, if request.query { 1.0 } else { 0.0 }, 0.25]))
        }, std::io::stdin().lock(), std::io::stdout().lock())
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
    provider: EmbeddingProvider,
    listener: tokio::net::TcpListener,
    _cache: tempfile::TempDir,
}

async fn fixture(idle: Duration) -> Fixture {
    fixture_with(idle, Limits::NODE).await
}

async fn fixture_with(idle: Duration, limits: Limits) -> Fixture {
    let cache = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = EmbedConfig {
        model_id: config::DEFAULT_MODEL_ID.to_owned(), cache_dir: cache.path().to_owned(),
        ort_library: "unused".into(), dtype: None, sessions: 1,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    };
    let mut launch = test_launch("scripted");
    launch.env.push((REPORT.into(), listener.local_addr().unwrap().to_string()));
    let provider = EmbeddingProvider::installed_with_load(cache.path(), move || {
        let (config, launch) = (config.clone(), launch.clone());
        Box::pin(async move { Embedder::start_within(config, launch, limits).await.map_err(|e| e.message()) })
    }).with_idle_timeout(idle);
    Fixture { provider, listener, _cache: cache }
}

async fn peer(listener: &tokio::net::TcpListener) -> (tokio::net::TcpStream, u32) {
    let (stream, pid, _) = peer_reporting(listener).await;
    (stream, pid)
}

/// [`peer`], and whether the host reported that it started below normal priority.
async fn peer_reporting(listener: &tokio::net::TcpListener) -> (tokio::net::TcpStream, u32, bool) {
    let (mut stream, _) = mixdog_rt::time::timeout(LIMIT, listener.accept()).await.unwrap().unwrap();
    let pid = stream.read_u32_le().await.unwrap();
    assert_ne!(pid, std::process::id(), "inference belongs to a child");
    let below = stream.read_u8().await.unwrap() == 1;
    (stream, pid, below)
}

async fn ended(stream: &mut tokio::net::TcpStream) {
    let outcome = mixdog_rt::time::timeout(LIMIT, stream.read(&mut [0u8; 1])).await.expect("host exits");
    assert!(matches!(outcome, Ok(0) | Err(_)), "{outcome:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_are_answered_by_the_child_and_drop_ends_it() {
    let f = fixture(Duration::ZERO).await;
    assert!(!f.provider.is_ready());
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f.listener).await;
    assert_eq!(model.embed("hello", InputType::Query).await.unwrap().as_slice(), [5.0, 1.0, 0.25]);
    let batch = model.embed_batch(&["a".into(), "xyz".into()], InputType::Document).await.unwrap();
    assert_eq!(batch[0].as_slice(), [1.0, 0.0, 0.25]);
    assert_eq!(batch[1].as_slice(), [3.0, 0.0, 0.25]);
    drop(model);
    drop(f);
    ended(&mut stream).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_exit_releases_the_child_and_the_next_request_restarts_it() {
    let f = fixture(Duration::from_millis(40)).await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, first) = peer(&f.listener).await;
    let expected = model.embed("hello", InputType::Query).await.unwrap();
    drop(model);
    ended(&mut stream).await;
    assert!(!f.provider.is_ready());
    let next = f.provider.warmup().await.unwrap().unwrap();
    let (mut new_stream, second) = peer(&f.listener).await;
    assert_ne!(first, second);
    assert_eq!(next.embed("hello", InputType::Query).await.unwrap(), expected);
    drop(next);
    drop(f);
    ended(&mut new_stream).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn death_during_a_request_fails_promptly_and_the_next_request_succeeds() {
    let f = fixture(Duration::ZERO).await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, first) = peer(&f.listener).await;
    let failure = mixdog_rt::time::timeout(LIMIT, model.embed("crash", InputType::Document)).await.expect("no hang").unwrap_err();
    assert!(failure.message().contains("host exited"), "{failure}");
    ended(&mut stream).await;
    assert!(!f.provider.is_ready());
    // A host that died makes the next launch wait out Node's restart backoff (1 s after the first failure).
    f.provider.stamp_launch_now();
    let refused = f.provider.warmup().await.err().expect("refused during the backoff");
    assert!(refused.contains("restart backoff"), "{refused}");
    f.provider.backdate_launch(Duration::from_secs(1));
    let next = f.provider.warmup().await.unwrap().unwrap();
    let (mut new_stream, second) = peer(&f.listener).await;
    assert_ne!(first, second);
    assert_eq!(next.embed("hello", InputType::Query).await.unwrap().as_slice(), [5.0, 1.0, 0.25]);
    drop((model, next, f));
    ended(&mut new_stream).await;
}

/// A loaded host that does not answer is ended once its request limit passes instead of holding the exchange for good (the limit is shortened here), and the
/// next request starts another host.
#[tokio::test(flavor = "multi_thread")]
async fn a_host_that_never_answers_is_ended_at_its_request_limit_and_the_next_request_starts_another() {
    let f = fixture_with(Duration::ZERO, Limits::new(LIMIT, Duration::from_millis(300))).await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, first) = peer(&f.listener).await;
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
    let (mut new_stream, second) = peer(&f.listener).await;
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
        model_id: config::DEFAULT_MODEL_ID.to_owned(), cache_dir: cache.path().to_owned(),
        ort_library: "unused".into(), dtype: None, sessions: 1,
        lane: mixdog_rt::testing::tokens().cpu_bulk,
    };
    let began = std::time::Instant::now();
    let failure = mixdog_rt::time::timeout(LIMIT, Embedder::start_within(config, test_launch("silent"), Limits::new(Duration::from_millis(600), Duration::from_millis(100))))
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
    let f = fixture(Duration::ZERO).await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, pid, below) = peer_reporting(&f.listener).await;
    assert!(below, "the host process {pid} started at: {}", crate::memory::tests::fakes::priority_report(pid));
    drop((model, f));
    ended(&mut stream).await;
}

/// A host loads on one core and has all its cores again once loaded (the child exits 41 when its load ran on several).
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn the_host_loads_on_one_core_and_infers_on_all_of_them() {
    let f = fixture(Duration::ZERO).await;
    let model = f.provider.warmup().await.expect("the load ran on one core").unwrap();
    let (mut stream, _) = peer(&f.listener).await;
    assert_eq!(model.embed("cores", InputType::Document).await.unwrap()[0], affinity_cores() as f32);
    drop((model, f));
    ended(&mut stream).await;
}
/// A late alarm of a finished exchange does nothing: the identity it was armed for is no longer the armed one, so it cannot kill the host a later exchange uses.
#[tokio::test(flavor = "multi_thread")]
async fn an_alarm_of_a_finished_exchange_cannot_kill_the_next_one() {
    let f = fixture(Duration::ZERO).await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (_stream, _) = peer(&f.listener).await;
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
    let f = Arc::new(fixture(Duration::ZERO).await);
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f.listener).await;
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
    let (mut next_stream, _) = peer(&f.listener).await;
    drop((model, f));
    ended(&mut next_stream).await;
}

/// A non-zero exit adds one, once, however many warmups meet it.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_exit_is_accounted_once_by_concurrent_warmups() {
    let f = Arc::new(fixture(Duration::ZERO).await);
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f.listener).await;
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
    let f = fixture(Duration::ZERO).await;
    let old = f.provider.warmup().await.unwrap().unwrap();
    let (_old_stream, _) = peer(&f.listener).await;
    f.provider.set_restart_count(2);
    // Past the backoff the count asks for, so the replacement launches at once.
    f.provider.backdate_launch(Duration::from_secs(60));
    let before = f.provider.accountings();
    f.provider.dispose();
    let next = f.provider.warmup().await.unwrap().unwrap();
    let (mut next_stream, _) = peer(&f.listener).await;
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
    let f = fixture(Duration::ZERO).await;
    let model = f.provider.warmup().await.unwrap().unwrap();
    let (mut stream, _) = peer(&f.listener).await;
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