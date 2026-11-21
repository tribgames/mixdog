use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use flate2::Compression;
use flate2::write::GzEncoder;
use mixdog_office_pdf::ocr::engine::{AcquireOptions, BoxFuture, EngineConfig, EngineProcess, EngineStarter, Image, OcrEngines, Recognition, UNAVAILABLE};
use mixdog_office_pdf::ocr::install::{self, ArchiveFormat, EngineAsset};
use mixdog_rt::time;
use mixdog_rt::{CancellationToken, LaneTokens};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_time().enable_io().build().expect("runtime").block_on(future)
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(mixdog_testkit::target_tmpdir!()).join("ocr-engine").join(name);
    if mixdog_testkit::exists(&dir) {
        mixdog_testkit::remove_dir_all(&dir);
    }
    mixdog_testkit::create_dir_all(&dir);
    dir
}

// stand-in engines

/// An engine that never answers a page, and notes that it was ended.
struct Stub {
    terminated: Arc<AtomicBool>,
    ended: CancellationToken,
}

impl EngineProcess for Stub {
    fn recognize<'a>(&'a self, _image: Image, _with_words: bool, cancel: &'a CancellationToken) -> BoxFuture<'a, Result<Recognition, String>> {
        Box::pin(async move {
            tokio::select! {
                () = cancel.cancelled() => Err("the page was cancelled".to_owned()),
                () = self.ended.cancelled() => Err("OCR engine ended".to_owned()),
            }
        })
    }

    fn terminate(&self) {
        self.terminated.store(true, Ordering::SeqCst);
        self.ended.cancel();
    }
}

/// Counts how many starts were dropped before they finished.
struct Dropped(Arc<AtomicUsize>);

impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// A start that is ready after `ready_after` (never when `None`).
struct StubStarter {
    ready_after: Option<Duration>,
    starts: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    terminated: Arc<AtomicBool>,
}

impl StubStarter {
    fn new(ready_after: Option<Duration>) -> Arc<Self> {
        Arc::new(StubStarter { ready_after, starts: Arc::default(), dropped: Arc::default(), terminated: Arc::default() })
    }
}

fn options(name: &str) -> AcquireOptions {
    AcquireOptions::new("eng", scratch(name))
}

#[test]
fn an_already_cancelled_call_does_not_start_an_engine() {
    run(async {
        let starter = StubStarter::new(Some(Duration::from_millis(10)));
        let engines = Arc::new(OcrEngines::new(Arc::clone(&starter) as Arc<dyn EngineStarter>));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut asked = options("cancelled-first");
        asked.cancel = Some(cancel);
        assert_eq!(engines.acquire(asked).await.err().expect("cancelled").message, "PDF OCR was cancelled");
        assert_eq!(starter.starts.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn a_page_cancelled_while_another_caller_holds_the_engine_leaves_the_engine_running() {
    run(async {
        let starter = StubStarter::new(Some(Duration::from_millis(10)));
        let engines = Arc::new(OcrEngines::new(Arc::clone(&starter) as Arc<dyn EngineStarter>));
        let first = engines.acquire(options("shared-cancel")).await.expect("ready");
        let second = engines.acquire(options("shared-cancel")).await.expect("ready");
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(first.recognize(Image::Bytes(Vec::new()), false, Some(&cancel)).await.is_err());
        assert_eq!(engines.live(), 1);
        assert!(!starter.terminated.load(Ordering::SeqCst));
        first.release();
        second.release();
        assert_eq!(engines.live(), 0);
        assert!(starter.terminated.load(Ordering::SeqCst));
    });
}

#[test]
fn two_first_calls_at_once_share_one_engine_start() {
    run(async {
        let starter = StubStarter::new(Some(Duration::from_millis(100)));
        let engines = Arc::new(OcrEngines::new(Arc::clone(&starter) as Arc<dyn EngineStarter>));
        let cache = scratch("share");
        let ask = || {
            let mut asked = AcquireOptions::new("eng+kor", cache.clone());
            asked.cache_path = cache.join("languages");
            asked
        };
        let (first, second) = tokio::join!(engines.acquire(ask()), engines.acquire(ask()));
        let (first, second) = (first.expect("first"), second.expect("second"));
        assert_eq!(starter.starts.load(Ordering::SeqCst), 1, "one engine for both callers");
        assert_eq!(engines.live(), 1);
        first.release();
        assert_eq!(engines.live(), 1, "kept while the other caller holds it");
        assert!(!starter.terminated.load(Ordering::SeqCst));
        second.release();
        assert_eq!(engines.live(), 0);
        assert!(starter.terminated.load(Ordering::SeqCst));
    });
}

#[test]
fn a_released_engine_is_started_again_by_the_next_caller() {
    run(async {
        let starter = StubStarter::new(Some(Duration::from_millis(5)));
        let engines = Arc::new(OcrEngines::new(Arc::clone(&starter) as Arc<dyn EngineStarter>));
        engines.acquire(options("again")).await.expect("ready").release();
        engines.acquire(options("again")).await.expect("ready").release();
        assert_eq!(starter.starts.load(Ordering::SeqCst), 2);
    });
}

// the downloads

/// A server of fixed answers by path; a path it does not know is 404. It reports each request line.
async fn serve(routes: HashMap<String, Vec<u8>>) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = format!("http://{}", listener.local_addr().expect("address"));
    let (seen, requests) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let (routes, seen) = (routes.clone(), seen.clone());
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut chunk = [0u8; 1024];
                while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => head.extend_from_slice(&chunk[..read]),
                    }
                }
                let line = String::from_utf8_lossy(&head).lines().next().unwrap_or_default().to_owned();
                let path = line.split(' ').nth(1).unwrap_or_default().to_owned();
                let _ = seen.send(path.clone());
                let (status, body) = match routes.get(&path) {
                    Some(body) => ("200 OK", body.clone()),
                    None => ("404 Not Found", Vec::new()),
                };
                let reply = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = socket.write_all(reply.as_bytes()).await;
                let _ = socket.write_all(&body).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (address, requests)
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).expect("write");
    encoder.finish().expect("finish")
}

fn sha256(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Leaks a boxed text as the `'static` the asset table wants.
fn leak(text: String) -> &'static str {
    Box::leak(text.into_boxed_str())
}

fn engine_asset(url: String, sha256: String, format: ArchiveFormat, executable: &'static str) -> &'static [EngineAsset] {
    Box::leak(Box::new([EngineAsset { platform: "test-x64", url: leak(url), sha256: leak(sha256), format, executable }]))
}

fn lanes() -> LaneTokens {
    mixdog_rt::testing::tokens()
}
impl EngineStarter for StubStarter {
    fn start(&self, _config: EngineConfig) -> BoxFuture<'static, Result<Arc<dyn EngineProcess>, String>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let (ready_after, terminated, guard) = (self.ready_after, Arc::clone(&self.terminated), Dropped(Arc::clone(&self.dropped)));
        Box::pin(async move {
            let _guard = guard;
            match ready_after {
                Some(delay) => {
                    time::sleep(delay).await;
                    let process: Arc<dyn EngineProcess> = Arc::new(Stub { terminated, ended: CancellationToken::new() });
                    Ok(process)
                }
                None => std::future::pending().await,
            }
        })
    }
}
// the lifecycle

#[test]
fn a_start_that_never_finishes_times_out_and_is_ended_leaving_nothing_running() {
    run(async {
        let starter = StubStarter::new(None);
        let engines = Arc::new(OcrEngines::new(Arc::clone(&starter) as Arc<dyn EngineStarter>));
        let mut asked = options("timeout");
        asked.timeout = Duration::from_millis(200);
        let error = engines.acquire(asked).await.err().expect("the start must time out");
        assert_eq!(error.code, Some(UNAVAILABLE));
        assert!(error.message.contains("did not load in time"), "{}", error.message);
        assert_eq!(starter.starts.load(Ordering::SeqCst), 1);
        time::sleep(Duration::from_millis(20)).await;
        assert_eq!(starter.dropped.load(Ordering::SeqCst), 1, "the start was dropped with what it held");
        assert_eq!(engines.live(), 0);
    });
}
#[test]
fn cancelling_while_the_engine_starts_ends_the_start_at_once() {
    run(async {
        let starter = StubStarter::new(None);
        let engines = Arc::new(OcrEngines::new(Arc::clone(&starter) as Arc<dyn EngineStarter>));
        let cancel = CancellationToken::new();
        let mut asked = options("cancel-start");
        asked.cancel = Some(cancel.clone());
        let stop = cancel.clone();
        let later = tokio::spawn(async move {
            time::sleep(Duration::from_millis(50)).await;
            stop.cancel();
        });
        let error = engines.acquire(asked).await.err().expect("cancelled");
        later.await.expect("timer");
        assert_eq!(error.message, "PDF OCR was cancelled");
        time::sleep(Duration::from_millis(20)).await;
        assert_eq!(starter.dropped.load(Ordering::SeqCst), 1);
        assert_eq!(engines.live(), 0);
    });
}
#[test]
fn cancelling_a_page_in_recognition_ends_the_engine() {
    run(async {
        let starter = StubStarter::new(Some(Duration::from_millis(10)));
        let engines = Arc::new(OcrEngines::new(Arc::clone(&starter) as Arc<dyn EngineStarter>));
        let engine = engines.acquire(options("cancel-page")).await.expect("ready");
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let later = tokio::spawn(async move {
            time::sleep(Duration::from_millis(50)).await;
            stop.cancel();
        });
        let error = engine.recognize(Image::Bytes(b"png".to_vec()), false, Some(&cancel)).await.err().expect("cancelled");
        later.await.expect("timer");
        assert_eq!(error.message, "PDF OCR was cancelled");
        assert!(starter.terminated.load(Ordering::SeqCst), "the engine was ended");
        assert_eq!(engines.live(), 0);
        engine.release();
    });
}
/// A starter that only fetches the language data, as the real one does after the program.
struct LanguagesOnly {
    lanes: LaneTokens,
    lang_path: String,
}
impl EngineStarter for LanguagesOnly {
    fn start(&self, config: EngineConfig) -> BoxFuture<'static, Result<Arc<dyn EngineProcess>, String>> {
        let (lanes, lang_path) = (self.lanes, self.lang_path.clone());
        Box::pin(async move {
            install::ensure_languages(&lanes, &config.languages, &config.cache_path, Some(&lang_path), &CancellationToken::new()).await?;
            let process: Arc<dyn EngineProcess> = Arc::new(Stub { terminated: Arc::default(), ended: CancellationToken::new() });
            Ok(process)
        })
    }
}
#[test]
fn cancelling_a_stalled_first_use_download_closes_the_download() {
    run(async {
        // A language server that accepts the download and never answers.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        let (arrived, requested) = tokio::sync::oneshot::channel::<String>();
        let (closed, socket_closed) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut head = [0u8; 1024];
            let read = socket.read(&mut head).await.expect("request");
            let _ = arrived.send(String::from_utf8_lossy(&head[..read]).lines().next().unwrap_or_default().to_owned());
            let mut rest = [0u8; 64];
            while matches!(socket.read(&mut rest).await, Ok(read) if read > 0) {}
            let _ = closed.send(());
        });
        let engines = Arc::new(OcrEngines::new(Arc::new(LanguagesOnly { lanes: lanes(), lang_path: format!("http://{address}/lang") })));
        let cancel = CancellationToken::new();
        let mut asked = options("stalled-download");
        asked.cancel = Some(cancel.clone());
        let pending = tokio::spawn({
            let engines = Arc::clone(&engines);
            async move { engines.acquire(asked).await.map(|engine| engine.release()) }
        });
        let line = requested.await.expect("the download was requested");
        assert!(line.contains("/lang/eng.traineddata"), "{line}");
        cancel.cancel();
        let error = pending.await.expect("task").expect_err("cancelled");
        assert_eq!(error.message, "PDF OCR was cancelled");
        time::timeout(Duration::from_secs(5), socket_closed).await.expect("the download's socket closed in time").expect("closed");
        assert_eq!(engines.live(), 0);
    });
}
#[test]
fn a_language_is_downloaded_decompressed_into_the_cache_and_not_fetched_twice() {
    run(async {
        let data = b"traineddata bytes".to_vec();
        let (address, mut requests) = serve(HashMap::from([("/lang/eng.traineddata.gz".to_owned(), gzip(&data))])).await;
        let cache = scratch("language").join("languages");
        let cancel = CancellationToken::new();
        install::ensure_languages(&lanes(), "eng+eng", &cache, Some(&format!("{address}/lang")), &cancel).await.expect("fetched");
        assert_eq!(mixdog_testkit::read(&cache.join("eng.traineddata")), data);
        assert_eq!(requests.recv().await.as_deref(), Some("/lang/eng.traineddata.gz"));
        // A second call finds it in the cache: the server is not asked again.
        install::ensure_languages(&lanes(), "eng", &cache, Some(&format!("{address}/lang")), &cancel).await.expect("cached");
        assert!(requests.try_recv().is_err(), "a cached language is not fetched");
        assert_eq!(mixdog_testkit::entry_names(&cache).len(), 1, "no partial file is left");
    });
}
#[test]
fn a_language_the_server_does_not_have_fails_with_the_response_code() {
    run(async {
        let (address, _requests) = serve(HashMap::new()).await;
        let cache = scratch("missing-language").join("languages");
        let url = format!("{address}/lang");
        let error = install::ensure_languages(&lanes(), "xyz", &cache, Some(&url), &CancellationToken::new()).await.expect_err("404");
        assert_eq!(error, format!("Network error while fetching {url}/xyz.traineddata.gz. Response code: 404"));
        assert!(!mixdog_testkit::exists(&cache.join("xyz.traineddata")));
    });
}
#[test]
fn a_language_name_that_is_a_path_is_refused_before_anything_is_fetched() {
    run(async {
        let cache = scratch("bad-language").join("languages");
        let error =
            install::ensure_languages(&lanes(), "../evil", &cache, Some("http://127.0.0.1:9/lang"), &CancellationToken::new()).await.expect_err("refused");
        assert_eq!(error, "Invalid OCR language: ../evil");
    });
}
#[test]
fn a_local_language_folder_is_read_without_a_download() {
    run(async {
        let folder = scratch("local-language");
        mixdog_testkit::write(&folder.join("kor.traineddata.gz"), gzip(b"korean"));
        let cache = folder.join("languages");
        install::ensure_languages(&lanes(), "kor", &cache, Some(&folder.to_string_lossy()), &CancellationToken::new()).await.expect("read");
        assert_eq!(mixdog_testkit::read(&cache.join("kor.traineddata")), b"korean");
    });
}
#[test]
fn the_readiness_lists_the_cached_languages_by_name_in_code_unit_order() {
    let data = scratch("readiness");
    let cache = mixdog_office_pdf::ocr::ocr_cache_path(&data);
    mixdog_testkit::create_dir_all(&cache);
    for name in ["kor.traineddata", "eng.traineddata.gz", "osd.traineddata", "notes.txt", ".traineddata"] {
        mixdog_testkit::write(&cache.join(name), b"x");
    }
    let ready = run(async { mixdog_office_pdf::ocr::pdf_ocr_readiness(&lanes(), &data).await.expect("readiness") });
    assert_eq!(ready["cachedLanguages"], serde_json::json!(["eng", "kor", "osd"]));
    assert_eq!(ready["backend"], "tesseract");
    assert!(ready["available"].is_boolean());
    assert_eq!(ready["cachePath"], cache.to_string_lossy().as_ref());
    assert!(ready["note"].as_str().expect("note").starts_with("A language not listed is downloaded on first use"));
    // A data folder with no cache lists nothing.
    let empty = run(async { mixdog_office_pdf::ocr::pdf_ocr_readiness(&lanes(), &scratch("readiness-empty")).await.expect("readiness") });
    assert_eq!(empty["cachedLanguages"], serde_json::json!([]));
}
#[test]
fn the_engine_is_downloaded_verified_unpacked_and_published_once() {
    run(async {
        let program = b"#!program".to_vec();
        let archive = gzip(&program);
        let (address, mut requests) = serve(HashMap::from([("/engine.gz".to_owned(), archive.clone())])).await;
        let assets = engine_asset(format!("{address}/engine.gz"), sha256(&archive), ArchiveFormat::Gzip, "tesseract");
        let root = scratch("engine-gz");
        let cancel = CancellationToken::new();
        let installed = install::ensure_engine(&lanes(), &root, assets, "test-x64", &cancel).await.expect("installed");
        assert_eq!(installed, root.join(install::ENGINE_VERSION).join("tesseract"));
        assert_eq!(mixdog_testkit::read(&installed), program);
        assert_eq!(requests.recv().await.as_deref(), Some("/engine.gz"));
        // Installed: not downloaded again, and no staging folder is left.
        assert_eq!(install::ensure_engine(&lanes(), &root, assets, "test-x64", &cancel).await.expect("again"), installed);
        assert!(requests.try_recv().is_err());
        assert_eq!(mixdog_testkit::entry_names(&root).len(), 1);
    });
}
#[test]
fn a_zip_engine_unpacks_its_libraries_beside_the_program_and_leaves_names_that_escape() {
    run(async {
        let mut archive = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut archive));
            let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            zip.start_file("bin/tesseract.exe", stored).expect("start");
            zip.write_all(b"program").expect("write");
            zip.start_file("bin/lib.dll", stored).expect("start");
            zip.write_all(b"library").expect("write");
            zip.start_file("../escaped.txt", stored).expect("start");
            zip.write_all(b"escape").expect("write");
            zip.finish().expect("finish");
        }
        let (address, _requests) = serve(HashMap::from([("/engine.zip".to_owned(), archive.clone())])).await;
        let assets = engine_asset(format!("{address}/engine.zip"), sha256(&archive).to_uppercase(), ArchiveFormat::Zip, "bin/tesseract.exe");
        let root = scratch("engine-zip");
        let installed = install::ensure_engine(&lanes(), &root, assets, "test-x64", &CancellationToken::new()).await.expect("installed");
        assert_eq!(mixdog_testkit::read(&installed), b"program");
        assert_eq!(mixdog_testkit::read(&root.join(install::ENGINE_VERSION).join("bin").join("lib.dll")), b"library");
        assert!(!mixdog_testkit::exists(&root.join("escaped.txt")));
        assert!(!mixdog_testkit::exists(&root.join(install::ENGINE_VERSION).join("escaped.txt")));
    });
}
#[test]
fn a_download_that_does_not_match_its_pin_installs_nothing() {
    run(async {
        let archive = gzip(b"program");
        let (address, _requests) = serve(HashMap::from([("/engine.gz".to_owned(), archive)])).await;
        let assets = engine_asset(format!("{address}/engine.gz"), sha256(b"something else"), ArchiveFormat::Gzip, "tesseract");
        let root = scratch("engine-mismatch");
        let error = install::ensure_engine(&lanes(), &root, assets, "test-x64", &CancellationToken::new()).await.expect_err("mismatch");
        assert!(error.contains("does not match its pinned checksum"), "{error}");
        assert!(!mixdog_testkit::exists(&root.join(install::ENGINE_VERSION)));
    });
}
#[test]
fn a_platform_without_a_pinned_asset_reports_that_ocr_is_unavailable_there() {
    run(async {
        let root = scratch("engine-none");
        let error = install::ensure_engine(&lanes(), &root, &[], "plan9-mips", &CancellationToken::new()).await.expect_err("no asset");
        assert!(error.contains("OCR is not available on this platform (plan9-mips)"), "{error}");
    });
}
