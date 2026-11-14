//! Installs against a local HTTP server: sizes, hashes, stamps, progress,
//! partial and failing downloads, cancellation, and the embedding model's
//! real files end to end.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::effort_judge::install::{self, Manifest, ManifestFile};
use crate::effort_judge::model::{ModelConfig, OrtRuntime};
use crate::memory::embed::engine::EmbedConfig;
use crate::memory::embed::install as embed_install;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::recall::QueryEmbedder;
use crate::model_install::{InstallError, Progress, ProgressSink, download_to_file, sha256_file, DownloadError, Spec};

#[derive(Clone)]
pub(super) enum Route {
    Body(Vec<u8>),
    File(PathBuf),
    /// Advertises `advertised` bytes and sends only the body.
    Truncated { body: Vec<u8>, advertised: usize },
    /// Sends the headers, then nothing: only a cancel ends the download.
    Stall,
}

pub(super) struct Server {
    pub(super) base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

impl Server {
    pub(super) async fn start(routes: Vec<(&str, Route)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let routes: HashMap<String, Route> = routes.into_iter().map(|(p, r)| (p.to_owned(), r)).collect();
        let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        let seen = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let (routes, seen) = (routes.clone(), seen.clone());
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 1024];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => request.extend_from_slice(&buffer[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let path = text.split_whitespace().nth(1).unwrap_or_default().to_owned();
                    *seen.lock().expect("hits").entry(path.clone()).or_default() += 1;
                    let header = |status: &str, length: usize| format!("HTTP/1.1 {status}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
                    match routes.get(&path) {
                        None => {
                            let _ = stream.write_all(header("404 Not Found", 0).as_bytes()).await;
                        }
                        Some(Route::Body(body)) => {
                            let _ = stream.write_all(header("200 OK", body.len()).as_bytes()).await;
                            let _ = stream.write_all(body).await;
                        }
                        Some(Route::File(file)) => {
                            let body = tokio::fs::read(file).await.unwrap_or_default();
                            let _ = stream.write_all(header("200 OK", body.len()).as_bytes()).await;
                            let _ = stream.write_all(&body).await;
                        }
                        Some(Route::Truncated { body, advertised }) => {
                            let _ = stream.write_all(header("200 OK", *advertised).as_bytes()).await;
                            let _ = stream.write_all(body).await;
                        }
                        Some(Route::Stall) => {
                            let _ = stream.write_all(header("200 OK", 1000).as_bytes()).await;
                            let _ = stream.flush().await;
                            std::future::pending::<()>().await;
                        }
                    }
                });
            }
        });
        Self { base, hits }
    }

    pub(super) fn hits(&self, path: &str) -> usize {
        self.hits.lock().expect("hits").get(path).copied().unwrap_or(0)
    }
}

pub(super) fn lane() -> mixdog_rt::CpuBulk {
    mixdog_rt::testing::tokens().cpu_bulk
}

pub(super) fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn recorder() -> (ProgressSink, Arc<Mutex<Vec<Progress>>>) {
    let log: Arc<Mutex<Vec<Progress>>> = Arc::default();
    let sink = log.clone();
    (Arc::new(move |p| sink.lock().expect("progress").push(p)), log)
}

pub(super) fn manifest(server: &Server, release: &str, files: &[(&str, &[u8])]) -> Manifest {
    Manifest::with_files(
        release,
        files.iter().map(|(name, bytes)| {
            (
                (*name).to_owned(),
                ManifestFile { url: format!("{}/{name}", server.base), sha256: sha(bytes), size: bytes.len() as u64 },
            )
        }),
    )
}

pub(super) fn config(dir: &Path) -> ModelConfig {
    ModelConfig { dir: dir.to_owned(), explicit: false, ort_library: OrtRuntime::Library(PathBuf::from("unused")) }
}

pub(super) fn big(seed: u8, len: usize) -> Vec<u8> {
    (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed) | 1).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn download_reports_bytes_checks_size_and_leaves_nothing_on_failure() {
    let body = big(1, 400_000);
    let server = Server::start(vec![
        ("/ok", Route::Body(body.clone())),
        ("/short", Route::Truncated { body: body[..1000].to_vec(), advertised: body.len() }),
    ])
    .await;
    let dir = tempfile::tempdir().expect("dir");
    let cancel = CancellationToken::new();
    let (sink, log) = recorder();

    let dest = dir.path().join("ok.bin");
    let url = format!("{}/ok", server.base);
    let spec = Spec { url: &url, dest: &dest, max_bytes: body.len() as u64, expected_bytes: body.len() as u64, label: "ok", lane: lane() };
    assert_eq!(download_to_file(&spec, Some(&sink), &cancel).await.expect("downloads"), body.len() as u64);
    assert_eq!(std::fs::read(&dest).expect("file"), body);
    let progress = log.lock().expect("log").clone();
    assert!(progress.len() >= 2, "{progress:?}");
    assert!(progress.windows(2).all(|w| w[0].downloaded <= w[1].downloaded));
    assert_eq!(progress.last().map(|p| (p.downloaded, p.total)), Some((body.len() as u64, body.len() as u64)));

    let short = dir.path().join("short.bin");
    let url = format!("{}/short", server.base);
    let spec = Spec { url: &url, dest: &short, max_bytes: 1 << 20, expected_bytes: 0, label: "short", lane: lane() };
    let error = download_to_file(&spec, None, &cancel).await.expect_err("truncated");
    assert!(matches!(error, DownloadError::Size(_) | DownloadError::Network(_)), "{error}");
    assert!(!short.exists(), "a failed download leaves no file");
    assert_eq!(server.hits("/short"), 4, "a failure is retried a few times");

    let url = format!("{}/missing", server.base);
    let spec = Spec { url: &url, dest: &short, max_bytes: 10, expected_bytes: 0, label: "missing", lane: lane() };
    let error = download_to_file(&spec, None, &cancel).await.expect_err("404");
    assert!(matches!(error, DownloadError::Http { status: 404, .. }), "{error}");
    assert_eq!(server.hits("/missing"), 1, "a 4xx answer is terminal");

    let over = Spec { url: &format!("{}/ok", server.base), dest: &short, max_bytes: 1000, expected_bytes: 0, label: "over", lane: lane() };
    assert!(matches!(download_to_file(&over, None, &cancel).await, Err(DownloadError::Size(_))));
    assert_eq!(sha256_file(lane(), &dest).await.expect("hash"), sha(&body));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_download_ends_without_any_timer() {
    let server = Server::start(vec![("/stall", Route::Stall)]).await;
    let dir = tempfile::tempdir().expect("dir");
    let cancel = CancellationToken::new();
    let url = format!("{}/stall", server.base);
    let dest = dir.path().join("stall.bin");
    let stopper = cancel.clone();
    let run = async {
        let spec = Spec { url: &url, dest: &dest, max_bytes: 1000, expected_bytes: 1000, label: "stall", lane: lane() };
        download_to_file(&spec, None, &cancel).await
    };
    let (result, ()) = tokio::join!(run, async {
        while server.hits("/stall") == 0 {
            tokio::task::yield_now().await;
        }
        stopper.cancel();
    });
    assert!(matches!(result, Err(DownloadError::Cancelled)));
    assert!(!dest.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn judge_install_verifies_stamps_skips_and_repairs() {
    let (model, tokenizer, calibration) = (big(2, 300_000), big(3, 120_000), br#"{"temperature":1.5,"steps":1}"#.to_vec());
    let files: [(&str, &[u8]); 3] = [("model.onnx", &model), ("tokenizer.json", &tokenizer), ("calibration.json", &calibration)];
    let server = Server::start(files.iter().map(|(n, b)| (format!("/{n}").leak() as &str, Route::Body(b.to_vec()))).collect()).await;
    let m = manifest(&server, "v1", &files);
    let dir = tempfile::tempdir().expect("dir");
    let target = dir.path().join("models").join("effort-judge");
    let cfg = config(&target);
    let cancel = CancellationToken::new();
    let (sink, log) = recorder();

    assert!(!crate::effort_judge::model::available(&cfg));
    install::ensure_installed(&cfg, &m, lane(), Some(&sink), &cancel).await.expect("installs");
    assert!(crate::effort_judge::model::available(&cfg));
    assert!(install::install_stamped(&target) && install::install_current(&target, &m));
    assert_eq!(std::fs::read(target.join("model.onnx")).expect("model"), model);
    assert!(log.lock().expect("log").iter().any(|p| p.label.ends_with("model.onnx") && p.downloaded == p.total));
    assert!(std::fs::read_dir(&target).expect("dir").all(|e| !e.expect("entry").file_name().to_string_lossy().ends_with(".part")));

    // Already current: nothing is fetched again.
    install::ensure_installed(&cfg, &m, lane(), None, &cancel).await.expect("current");
    assert_eq!(server.hits("/model.onnx"), 1);

    // A damaged file (same size, zeroed tail) invalidates the stamp; repair fetches only it.
    let mut damaged = model.clone();
    let cut = damaged.len() - 100;
    damaged[cut..].fill(0);
    std::fs::write(target.join("model.onnx"), damaged).expect("damage");
    let repaired = install::repair(&cfg, &m, lane(), None, &cancel).await.expect("repairs");
    assert_eq!(repaired, ["model.onnx"]);
    assert_eq!((server.hits("/model.onnx"), server.hits("/tokenizer.json")), (2, 1));
    assert!(install::install_current(&target, &m));
    assert_eq!(std::fs::read(target.join("model.onnx")).expect("model"), model);

    // A newer release downloads only what changed.
    let calibration2 = br#"{"temperature":2,"steps":1}"#.to_vec();
    let server2 = Server::start(vec![("/calibration.json", Route::Body(calibration2.clone()))]).await;
    let files2: [(&str, &[u8]); 3] = [("model.onnx", &model), ("tokenizer.json", &tokenizer), ("calibration.json", &calibration2)];
    let m2 = manifest(&server2, "v2", &files2);
    install::ensure_installed(&cfg, &m2, lane(), None, &cancel).await.expect("updates");
    assert_eq!(install::stamped_release(&target), "v2");
    assert_eq!(server2.hits("/calibration.json"), 1);
    assert_eq!(std::fs::read(target.join("calibration.json")).expect("cal"), calibration2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hash_mismatch_never_replaces_a_working_file() {
    let good = big(4, 50_000);
    let evil = big(5, 50_000);
    let server = Server::start(vec![("/model.onnx", Route::Body(evil))]).await;
    let m = manifest(&server, "v1", &[("model.onnx", &good)]);
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(dir.path().join("model.onnx"), b"previous working model").expect("seed");
    let error = install::install_model(dir.path(), &m, lane(), None, &CancellationToken::new()).await.expect_err("mismatch");
    assert!(matches!(error, InstallError::Hash { .. }), "{error}");
    assert_eq!(std::fs::read(dir.path().join("model.onnx")).expect("kept"), b"previous working model");
    assert!(!install::install_stamped(dir.path()));
}

#[test]
fn the_bundled_manifest_is_valid() {
    let m = Manifest::bundled().expect("valid");
    assert_eq!(m.release, "effort-judge-v7");
    assert_eq!(m.files().count(), 3);
}

/// The staged ONNX Runtime, for the integration tests that run real inference
/// (those are `#[ignore]`d with the reason; run them with `--ignored`).
pub(super) fn real_ort() -> PathBuf {
    PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY names the staged onnxruntime"))
}

/// A config whose runtime library does not exist: every load fails, which is
/// all the install and trigger logic needs.
pub(super) fn embed_config(cache: &Path) -> EmbedConfig {
    embed_config_with(cache, PathBuf::from("unused"))
}

pub(super) fn embed_config_with(cache: &Path, ort_library: PathBuf) -> EmbedConfig {
    EmbedConfig {
        model_id: crate::memory::embed::config::DEFAULT_MODEL_ID.into(),
        cache_dir: cache.to_owned(),
        ort_library,
        dtype: None,
        sessions: 1,
        lane: lane(),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: real inference needs the staged ONNX Runtime (MIXDOG_ORT_LIBRARY) and the e5 files (MIXDOG_MEMORY_MODELS)"]
async fn an_uninstalled_embedding_model_answers_no_vector_at_once_then_installs_and_works() {
    let source = PathBuf::from(std::env::var_os("MIXDOG_MEMORY_MODELS").expect("MIXDOG_MEMORY_MODELS"))
        .join("Xenova")
        .join("multilingual-e5-small");
    let id = crate::memory::embed::config::DEFAULT_MODEL_ID;
    let server = Server::start(vec![
        (&format!("/{id}/resolve/main/tokenizer.json"), Route::File(source.join("tokenizer.json"))),
        (&format!("/{id}/resolve/main/tokenizer_config.json"), Route::File(source.join("tokenizer_config.json"))),
        (&format!("/{id}/resolve/main/onnx/model_quantized.onnx"), Route::File(source.join("onnx").join("model_quantized.onnx"))),
    ])
    .await;
    let cache = tempfile::tempdir().expect("cache");
    let provider = Arc::new(EmbeddingProvider::new(embed_config_with(cache.path(), real_ort())).with_hub(server.base.clone()));
    // Recall asks the provider through `RecallEmbedder`, as `MemoryStack` wires it (memory/boot.rs).
    let recall = crate::memory::recall::readiness::RecallEmbedder::new(provider.clone(), false);

    assert!(!provider.is_installed().await.expect("reads"));
    let never = CancellationToken::new();
    assert_eq!(recall.query_vector("staging cluster", &never).await.expect("not aborted"), None, "not installed is a defined state, not a wait");

    let (sink, log) = recorder();
    provider.install(Some(&sink), &CancellationToken::new()).await.expect("installs");
    assert!(provider.is_installed().await.expect("reads"));
    assert!(log.lock().expect("log").iter().any(|p| p.label.contains("model_quantized") && p.downloaded == p.total && p.total > 0));
    assert_eq!(server.hits(&format!("/{id}/resolve/main/onnx/model_quantized.onnx_data")), 1, "optional weights are asked for");
    assert!(!embed_install::installed(&embed_config(&cache.path().join("nowhere"))));

    let vector = recall.query_vector("how do I restart the staging cluster", &never).await.expect("not aborted").expect("vector");
    let golden: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools/memory/embeddings/golden.json")).expect("golden");
    let want: Vec<f64> = golden["cases"][0]["vector"].as_array().expect("vector").iter().filter_map(|v| v.as_f64()).collect();
    let worst = vector.iter().zip(&want).map(|(a, b)| (f64::from(*a) - b).abs()).fold(0.0, f64::max);
    assert!(worst < 2e-5, "{worst}");

    // Installing again fetches nothing.
    provider.install(None, &CancellationToken::new()).await.expect("again");
    assert_eq!(server.hits(&format!("/{id}/resolve/main/tokenizer.json")), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_routed_by_the_network_proxy_policy_still_lands() {
    let policy = mixdog_ai::netproxy::NetworkProxy::new(Arc::new(mixdog_ai::netproxy::ProcessEnv), mixdog_ai::netproxy::SystemProxy::default());
    // Nothing goes out before the setting is read from the config once; this config names no proxy.
    policy.adopt(&serde_json::json!({ "mode": "off" }));
    let clients = mixdog_ai::netproxy::clients::RoutedClients::new(policy, |_| reqwest::Client::builder().no_proxy().build());
    crate::model_install::route_downloads(Arc::new(clients));
    let body = big(3, 5_000);
    let server = Server::start(vec![("/routed", Route::Body(body.clone()))]).await;
    let dir = tempfile::tempdir().expect("dir");
    let dest = dir.path().join("routed.bin");
    let url = format!("{}/routed", server.base);
    let spec = Spec { url: &url, dest: &dest, max_bytes: 10_000, expected_bytes: 0, label: "routed", lane: lane() };
    assert_eq!(download_to_file(&spec, None, &CancellationToken::new()).await.expect("downloads"), body.len() as u64);
    assert_eq!(std::fs::read(&dest).expect("file"), body);
}
