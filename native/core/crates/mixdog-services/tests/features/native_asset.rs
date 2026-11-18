//! The prebuilt graph binary: trusted only by an exact release address and digest, installed once, verified.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_services::native_asset::{AssetDownloader, GraphBinary};
use mixdog_services::tidy::install::platform_key_candidates;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BYTES: &[u8] = b"the graph binary";

struct Served {
    bytes: Vec<u8>,
    downloads: AtomicUsize,
    urls: Mutex<Vec<String>>,
}

#[async_trait]
impl AssetDownloader for Served {
    async fn download(&self, url: &str, dest: &Path) -> Result<(), String> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        self.urls.lock().unwrap().push(url.to_owned());
        std::fs::write(dest, &self.bytes).map_err(|e| e.to_string())
    }
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn exe() -> &'static str {
    if cfg!(windows) { ".exe" } else { "" }
}

fn manifest(version: &str, url: Option<String>, digest: String) -> Value {
    let key = platform_key_candidates()[0].clone();
    let url = url.unwrap_or_else(|| format!("https://github.com/tribgames/mixdog/releases/download/graph-v{version}/mixdog-graph-{key}{}", exe()));
    json!({"version": version, "assets": {key: {"url": url, "sha256": digest}}})
}

fn fetcher(dir: &Path, manifest: Value, bytes: &[u8]) -> (GraphBinary, Arc<Served>) {
    let served = Arc::new(Served { bytes: bytes.to_vec(), downloads: AtomicUsize::new(0), urls: Mutex::default() });
    let tokens = mixdog_rt::testing::tokens();
    (GraphBinary::new(dir.to_owned(), manifest, tokens.durability_io, tokens.cpu_bulk, served.clone(), Arc::new(|| 1_800_000_000_000)), served)
}

fn installed(dir: &Path, version: &str) -> PathBuf {
    dir.join("graph-bin").join(format!("mixdog-graph-{version}{}", exe()))
}

#[tokio::test]
async fn the_binary_is_downloaded_verified_installed_and_then_found_without_the_network() {
    let dir = tempfile::tempdir().unwrap();
    let (graph, served) = fetcher(dir.path(), manifest("1.2.3", None, sha(BYTES)), BYTES);
    assert_eq!(graph.find_cached().await, None);
    let path = graph.ensure().await.unwrap();
    assert_eq!(path, installed(dir.path(), "1.2.3"));
    assert_eq!(std::fs::read(&path).unwrap(), BYTES);
    assert!(served.urls.lock().unwrap()[0].contains("/graph-v1.2.3/mixdog-graph-"));
    assert_eq!(graph.find_cached().await, Some(path.clone()));
    assert_eq!(graph.ensure().await.unwrap(), path);
    assert_eq!(served.downloads.load(Ordering::SeqCst), 1, "an installed, matching binary is not downloaded again");
}

#[tokio::test]
async fn a_download_that_does_not_match_the_manifest_digest_installs_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (graph, _) = fetcher(dir.path(), manifest("1.2.3", None, sha(BYTES)), b"tampered");
    let error = graph.ensure().await.unwrap_err();
    assert!(error.starts_with("[graph-fetcher] sha256 mismatch for "), "{error}");
    assert!(error.contains(&sha(BYTES)) && error.contains(&sha(b"tampered")));
    assert!(!installed(dir.path(), "1.2.3").exists());
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("graph-bin")).unwrap().collect();
    assert!(leftovers.is_empty(), "the temporary download is removed");
}

#[tokio::test]
async fn an_installed_file_that_is_not_the_manifests_binary_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(dir.path(), "1.2.3");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"corrupt").unwrap();
    let (graph, served) = fetcher(dir.path(), manifest("1.2.3", None, sha(BYTES)), BYTES);
    assert_eq!(graph.find_cached().await, None);
    graph.ensure().await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), BYTES);
    assert_eq!(served.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_upgrade_removes_the_older_binaries_and_keeps_the_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("graph-bin");
    std::fs::create_dir_all(&bin).unwrap();
    for stale in [format!("mixdog-graph-1.0.0{}", exe()), "mixdog-graph-1.2.3.exe.tmp-1-2".to_owned(), "manifest.json".to_owned(), "unrelated.txt".to_owned()] {
        std::fs::write(bin.join(stale), "x").unwrap();
    }
    let (graph, _) = fetcher(dir.path(), manifest("1.2.3", None, sha(BYTES)), BYTES);
    graph.ensure().await.unwrap();
    let mut names: Vec<String> = std::fs::read_dir(&bin).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let mut expected = vec!["manifest.json".to_owned(), format!("mixdog-graph-1.2.3{}", exe()), "unrelated.txt".to_owned()];
    expected.sort();
    assert_eq!(names, expected);
}

#[tokio::test]
async fn a_manifest_asset_is_trusted_only_with_a_strict_version_an_exact_url_and_a_real_digest() {
    let dir = tempfile::tempdir().unwrap();
    let good_url = |v: &str| format!("https://github.com/tribgames/mixdog/releases/download/graph-v{v}/mixdog-graph-{}{}", platform_key_candidates()[0], exe());
    let cases = [
        manifest("1.2", None, sha(BYTES)),
        manifest("01.2.3", None, sha(BYTES)),
        manifest("1.2.3", Some("https://evil.example/graph".to_owned()), sha(BYTES)),
        manifest("1.2.3", Some(good_url("1.2.4")), sha(BYTES)),
        manifest("1.2.3", None, "abc".to_owned()),
        json!({"version": "1.2.3"}),
    ];
    for m in cases {
        let (graph, served) = fetcher(dir.path(), m.clone(), BYTES);
        let error = graph.ensure().await.unwrap_err();
        assert!(error.starts_with("[graph-fetcher] no prebuilt mixdog-graph binary for platform "), "{m}: {error}");
        assert_eq!(graph.find_cached().await, None);
        assert_eq!(served.downloads.load(Ordering::SeqCst), 0, "nothing is downloaded from an untrusted manifest");
    }
}

#[tokio::test]
async fn the_refusal_lists_the_platforms_the_manifest_does_have() {
    let dir = tempfile::tempdir().unwrap();
    let m = json!({"version": "1.2.3", "assets": {"plan9-mips": {"url": "x", "sha256": "y"}}});
    let (graph, _) = fetcher(dir.path(), m, BYTES);
    let error = graph.ensure().await.unwrap_err();
    assert!(error.contains("Supported platforms: plan9-mips."), "{error}");
}
