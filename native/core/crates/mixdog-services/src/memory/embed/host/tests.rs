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
        stream.write_all(&std::process::id().to_le_bytes()).unwrap();
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
    } else {
        serve_model(|| Ok(Scripted), |_, request| {
            if request.text == "crash" { std::process::exit(19); }
            Ok(Arc::new(vec![request.text.len() as f32, if request.query { 1.0 } else { 0.0 }, 0.25]))
        }, std::io::stdin().lock(), std::io::stdout().lock())
    };
    std::process::exit(code);
}

struct Fixture {
    provider: EmbeddingProvider,
    listener: tokio::net::TcpListener,
    _cache: tempfile::TempDir,
}

async fn fixture(idle: Duration) -> Fixture {
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
        Box::pin(async move { Embedder::start(config, launch).await.map_err(|e| e.message()) })
    }).with_idle_timeout(idle);
    Fixture { provider, listener, _cache: cache }
}

async fn peer(listener: &tokio::net::TcpListener) -> (tokio::net::TcpStream, u32) {
    let (mut stream, _) = mixdog_rt::time::timeout(LIMIT, listener.accept()).await.unwrap().unwrap();
    let pid = stream.read_u32_le().await.unwrap();
    assert_ne!(pid, std::process::id(), "inference belongs to a child");
    (stream, pid)
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
    let next = f.provider.warmup().await.unwrap().unwrap();
    let (mut new_stream, second) = peer(&f.listener).await;
    assert_ne!(first, second);
    assert_eq!(next.embed("hello", InputType::Query).await.unwrap().as_slice(), [5.0, 1.0, 0.25]);
    drop((model, next, f));
    ended(&mut new_stream).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MIXDOG_MEMORY_MODELS and MIXDOG_ORT_LIBRARY"]
async fn real_child_vectors_equal_the_in_process_engine() {
    let config = EmbedConfig {
        model_id: config::DEFAULT_MODEL_ID.to_owned(),
        cache_dir: std::env::var_os("MIXDOG_MEMORY_MODELS").expect("model cache").into(),
        ort_library: std::env::var_os("MIXDOG_ORT_LIBRARY").expect("runtime library").into(),
        dtype: None, sessions: 1, lane: mixdog_rt::testing::tokens().cpu_bulk,
    };
    let remote = Embedder::start(config.clone(), real_launch(&config)).await.unwrap();
    let local = super::super::engine::Embedder::load(config).await.unwrap();
    for input_type in [InputType::Query, InputType::Document] {
        for text in ["", "hello world", "한국어 기억 검색", "duplicate query"] {
            assert_eq!(remote.embed(text, input_type).await.unwrap(), local.embed(text, input_type).await.unwrap());
        }
    }
}
