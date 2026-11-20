//! The graph binary fetcher against the Node golden (`fixtures/native-asset/graph-binary.json`,
//! recorded by `benchmarks/rust-core/recorders/record-graph-binary.mjs` from the Node product on a
//! temp data dir): every manifest the fetcher distinguishes with the download stubbed, and the
//! production downloader against a local server.

use std::path::Path;
use std::sync::{Arc, Mutex};

use mixdog_rt::DurabilityIo;
use serde_json::Value;

use super::{AssetDownloader, GraphBinary, bin_suffix, sha256_file};
use crate::memory::ingest::system_now;
use crate::model_install::fsio;

/// `options.download` of the Node recording: writes what the scenario serves, or fails.
struct Stub {
    durability: DurabilityIo,
    dir: std::path::PathBuf,
    served: String,
    fail: Option<String>,
    calls: Mutex<Vec<(String, bool)>>,
}

#[async_trait::async_trait]
impl AssetDownloader for Stub {
    async fn download(&self, url: &str, dest: &Path) -> Result<(), String> {
        let tmp = dest.starts_with(&self.dir) && dest.file_name().is_some_and(|n| n.to_string_lossy().contains(".tmp-"));
        self.calls.lock().expect("calls").push((url.to_owned(), tmp));
        if let Some(message) = &self.fail {
            return Err(message.clone());
        }
        fsio::write(self.durability, dest, self.served.clone().into_bytes()).await.map_err(|e| e.to_string())
    }
}

/// Node's platform list (`NATIVE_ASSET_PLATFORMS`) is what the bundled manifest publishes, Windows on ARM included.
#[test]
fn the_bundled_manifest_publishes_every_release_platform() {
    let manifest = super::bundled_manifest();
    let mut keys: Vec<&str> = manifest["assets"].as_object().expect("assets").keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
}

/// A manifest of version 1.2.3 whose trusted assets are `keys`, each with the digest of `bytes`.
async fn manifest_for(keys: &[&str], bytes: &str) -> Value {
    let tokens = mixdog_rt::testing::tokens();
    let scratch = tempfile::tempdir().expect("scratch");
    let file = scratch.path().join("asset");
    fsio::write(tokens.durability_io, &file, bytes.as_bytes().to_vec()).await.expect("asset");
    let sha = sha256_file(tokens.cpu_bulk, &file).await.expect("digest");
    let assets: serde_json::Map<String, Value> = keys
        .iter()
        .map(|key| {
            let url = format!("https://github.com/tribgames/mixdog/releases/download/graph-v1.2.3/mixdog-graph-{key}{}", bin_suffix());
            ((*key).to_owned(), serde_json::json!({ "url": url, "sha256": sha }))
        })
        .collect();
    serde_json::json!({ "version": "1.2.3", "assets": assets })
}
fn stub(dir: &Path, served: &str) -> Arc<Stub> {
    Arc::new(Stub {
        durability: mixdog_rt::testing::tokens().durability_io,
        dir: dir.to_owned(),
        served: served.to_owned(),
        fail: None,
        calls: Mutex::new(Vec::new()),
    })
}
/// Node's "Windows on ARM prepares the native assets it runs under x64 emulation": a win32-arm64 host whose manifest
/// publishes only win32-x64 installs that asset.
#[tokio::test]
async fn windows_on_arm_installs_the_x64_asset_it_runs_under_emulation() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let dir = data.path().join("graph-bin");
    let downloads = stub(&dir, "graph");
    let manifest = manifest_for(&["win32-x64", "linux-x64"], "graph").await;
    let binary = GraphBinary::new(data.path().to_owned(), manifest, tokens.durability_io, tokens.cpu_bulk, downloads.clone(), system_now())
        .on_host("windows", "aarch64");
    let installed = binary.ensure().await.expect("the x64 asset installs");
    assert_eq!(installed, dir.join(format!("mixdog-graph-1.2.3{}", bin_suffix())));
    let urls: Vec<String> = downloads.calls.lock().expect("calls").iter().map(|(url, _)| url.clone()).collect();
    assert_eq!(urls, [format!("https://github.com/tribgames/mixdog/releases/download/graph-v1.2.3/mixdog-graph-win32-x64{}", bin_suffix())]);
}
/// Node's "unsupported host platforms fail closed before downloading native assets": a freebsd-x64 host is refused with
/// the platform named, nothing is downloaded and no install directory is made.
#[tokio::test]
async fn an_unsupported_host_is_refused_before_any_download() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().expect("data dir");
    let dir = data.path().join("graph-bin");
    let downloads = stub(&dir, "graph");
    let published = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
    let manifest = manifest_for(&published, "graph").await;
    let binary =
        GraphBinary::new(data.path().to_owned(), manifest, tokens.durability_io, tokens.cpu_bulk, downloads.clone(), system_now()).on_host("freebsd", "x86_64");
    let refused = binary.ensure().await.expect_err("freebsd-x64 has no asset");
    assert!(refused.contains("no prebuilt mixdog-graph binary for platform freebsd-x64"), "{refused}");
    assert!(downloads.calls.lock().expect("calls").is_empty(), "nothing is downloaded");
    assert!(!fsio::exists(tokens.durability_io, &dir).await.expect("exists"), "no install directory");
}
