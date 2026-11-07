//! The graph binary fetcher against the Node golden (`fixtures/native-asset/graph-binary.json`,
//! recorded by `benchmarks/rust-core/recorders/record-graph-binary.mjs` from the Node product on a
//! temp data dir): every manifest the fetcher distinguishes with the download stubbed, and the
//! production downloader against a local server.

use std::path::Path;
use std::sync::{Arc, Mutex};

use mixdog_rt::DurabilityIo;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::{AssetDownloader, GraphBinary, ReleaseDownloader, bin_suffix, sha256_file};
use crate::memory::ingest::system_now;
use crate::model_install::fsio;
use crate::tidy::install::platform_key_candidates;

const GOLDEN: &str = include_str!("../../../../fixtures/native-asset/graph-binary.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden")
}

/// The golden's placeholders for this host.
fn host(text: &str, version: &str) -> String {
    let key = &platform_key_candidates()[0];
    let url = format!("https://github.com/tribgames/mixdog/releases/download/graph-v{version}/mixdog-graph-{key}{}", bin_suffix());
    text.replace("<URL>", &url).replace("<PKEY>", key).replace("<SUFFIX>", bin_suffix())
}

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

fn relative(path: Option<std::path::PathBuf>, dir: &Path) -> Value {
    path.map_or(Value::Null, |p| Value::String(p.strip_prefix(dir).expect("inside the bin dir").to_string_lossy().into_owned()))
}

#[tokio::test]
async fn installs_match_the_node_golden() {
    let golden = golden();
    let tokens = mixdog_rt::testing::tokens();
    for scenario in golden["install"].as_array().expect("installs") {
        let name = scenario["name"].as_str().expect("name");
        let version = scenario["manifest"]["version"].as_str().expect("version");
        let data = tempfile::tempdir().expect("data dir");
        let dir = data.path().join("graph-bin");
        let seed = scenario["seed"].as_array().expect("seed");
        if !seed.is_empty() {
            fsio::create_dir_all(tokens.durability_io, &dir).await.expect("bin dir");
        }
        for file in seed {
            fsio::write(tokens.durability_io, &dir.join(host(file["name"].as_str().expect("name"), version)), file["content"].as_str().expect("content").as_bytes().to_vec()).await.expect("seed");
        }
        // The template's version differs from the one its url names only for the leading-zero case,
        // whose url is spelled out in the manifest.
        let manifest: Value = serde_json::from_str(&host(&scenario["manifest"].to_string(), "1.2.3")).expect("manifest");
        let stub = Arc::new(Stub {
            durability: tokens.durability_io,
            dir: dir.clone(),
            served: scenario["served"].as_str().unwrap_or(golden["bytes"].as_str().expect("bytes")).to_owned(),
            fail: scenario["fail"].as_str().map(str::to_owned),
            calls: Mutex::new(Vec::new()),
        });
        let binary = GraphBinary::new(data.path().to_owned(), manifest, tokens.durability_io, tokens.cpu_bulk, stub.clone(), system_now());
        let case = |what: &str| format!("{name} / {what}");

        assert_eq!(relative(binary.find_cached().await, &dir), host_value(&scenario["findBefore"]), "{}", case("find before"));
        for (run, want) in scenario["outcomes"].as_array().expect("outcomes").iter().enumerate() {
            let got = binary.ensure().await;
            match (got, want.get("ok"), want.get("error")) {
                (Ok(path), Some(ok), _) => assert_eq!(relative(Some(path), &dir), host_value(ok), "{}", case(&format!("run {run}"))),
                (Err(text), _, Some(error)) => assert_eq!(text, host(error.as_str().expect("text"), "1.2.3"), "{}", case(&format!("run {run}"))),
                (got, ..) => panic!("{}: {got:?} against {want}", case(&format!("run {run}"))),
            }
        }
        let calls: Vec<Value> = stub.calls.lock().expect("calls").iter().map(|(url, tmp)| serde_json::json!({"url": url, "tmpName": tmp})).collect();
        let want_calls: Vec<Value> = scenario["calls"]
            .as_array()
            .expect("calls")
            .iter()
            .map(|c| serde_json::json!({"url": host(c["url"].as_str().expect("url"), "1.2.3"), "tmpName": c["tmpName"]}))
            .collect();
        assert_eq!(calls, want_calls, "{}", case("downloads"));
        assert_eq!(relative(binary.find_cached().await, &dir), host_value(&scenario["findAfter"]), "{}", case("find after"));
        let mut files = fsio::list_names(tokens.durability_io, &dir).await;
        files.sort();
        let want_files: Vec<String> = scenario["files"].as_array().expect("files").iter().map(|f| host(f.as_str().expect("file"), version)).collect();
        assert_eq!(files, want_files, "{}", case("files"));
    }
}

fn host_value(value: &Value) -> Value {
    value.as_str().map_or(Value::Null, |text| Value::String(host(text, "1.2.3")))
}

/// A local server answering the golden's three routes.
async fn serve() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let hits: Arc<Mutex<std::collections::HashMap<String, usize>>> = Arc::default();
    let body = golden()["bytes"].as_str().expect("bytes").to_owned();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (hits, body) = (hits.clone(), body.clone());
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut chunk = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&chunk[..n]),
                    }
                }
                let target = String::from_utf8_lossy(&head).split_whitespace().nth(1).unwrap_or("/").to_owned();
                let n = {
                    let mut hits = hits.lock().expect("hits");
                    let n = hits.entry(target.clone()).or_insert(0);
                    *n += 1;
                    *n
                };
                let reply = match target.as_str() {
                    "/missing" => "HTTP/1.1 404 Not Found\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnope".to_owned(),
                    "/flaky" if n == 1 => "HTTP/1.1 500 Internal Server Error\r\ncontent-length: 5\r\nconnection: close\r\n\r\nlater".to_owned(),
                    _ => format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()),
                };
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    base
}

#[tokio::test]
async fn the_release_downloader_matches_the_node_golden() {
    let golden = golden();
    let tokens = mixdog_rt::testing::tokens();
    let base = serve().await;
    let downloader = ReleaseDownloader { bulk: tokens.cpu_bulk, durability: tokens.durability_io };
    let data = tempfile::tempdir().expect("data dir");
    for case in golden["downloads"].as_array().expect("downloads") {
        let route = case["route"].as_str().expect("route");
        let dest = data.path().join(route.trim_start_matches('/'));
        let got = downloader.download(&format!("{base}{route}"), &dest).await;
        match (got, case["outcome"].get("ok"), case["outcome"].get("error")) {
            (Ok(()), Some(sha), _) => assert_eq!(sha256_file(tokens.cpu_bulk, &dest).await.expect("hash"), sha.as_str().expect("sha"), "{route}"),
            (Err(text), _, Some(error)) => {
                assert_eq!(text, error.as_str().expect("text").replace("<BASE>", &base), "{route}");
                assert!(!fsio::exists(tokens.durability_io, &dest).await.expect("exists"), "{route}: a failed download leaves no file");
            }
            (got, ..) => panic!("{route}: {got:?} against {}", case["outcome"]),
        }
    }
}
