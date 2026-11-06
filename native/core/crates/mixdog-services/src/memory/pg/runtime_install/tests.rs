//! The PG runtime installer against the Node `ensureRuntime` golden
//! (`fixtures/tools/memory/runtime-install`, recorded by
//! `benchmarks/rust-core/recorders/record-runtime-install.mjs` from the Node product on a temp
//! data dir and a local stub release server): installs and cache hits, a bad checksum, locks of
//! every age and owner, platforms the manifest lacks, and the archive entry checks.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use mixdog_js::JsRegex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use super::retry::with_retry;
use super::tar::validate_entries;
use super::{InstallOptions, Manifest, Platform, RuntimeInstallError, ensure_runtime, repositories_env, url_candidates};
use crate::memory::ingest::system_now;
use crate::model_install::DownloadError;

const GOLDEN: &str = include_str!("../../../../../../fixtures/tools/memory/runtime-install/golden.json");
const ARCHIVE: &[u8] = include_bytes!("../../../../../../fixtures/tools/memory/runtime-install/runtime.tar.gz");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden")
}

fn platform_of(key: &str) -> Platform {
    let (os, arch) = key.split_once('-').expect("platform key");
    Platform::new(os, arch)
}

/// A release server that answers the golden scenario's routes.
struct Stub {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
}

async fn stub(serve: &Value) -> Stub {
    let routes: BTreeMap<String, String> =
        serve.as_object().expect("serve").iter().map(|(path, what)| (path.clone(), what.as_str().expect("route").to_owned())).collect();
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let requests: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = requests.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (routes, log) = (routes.clone(), log.clone());
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut chunk = [0u8; 1024];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&chunk[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&head);
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                log.lock().expect("log").push(path.clone());
                let reply = if routes.get(&path).is_some_and(|what| what == "archive") {
                    let mut reply = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", ARCHIVE.len()).into_bytes();
                    reply.extend_from_slice(ARCHIVE);
                    reply
                } else {
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot found".to_vec()
                };
                let _ = socket.write_all(&reply).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    Stub { base, requests }
}

fn now_ms() -> i64 {
    system_now()()
}

/// The golden's declarative seed: directories, text files (with `{self}` and `{now}`), NUL-filled
/// files, and files aged by `age_ms`.
fn apply_seed(data: &Path, seed: &Value) {
    for entry in seed.as_array().expect("seed") {
        let path = data.join(entry["path"].as_str().expect("path"));
        if entry["dir"] == json!(true) {
            std::fs::create_dir_all(&path).expect("dir");
            continue;
        }
        std::fs::create_dir_all(path.parent().expect("parent")).expect("parent");
        let bytes = match entry["zeros"].as_u64() {
            Some(zeros) => vec![0u8; zeros as usize],
            None => entry["text"]
                .as_str()
                .expect("text")
                .replace("{self}", &std::process::id().to_string())
                .replace("{now}", &now_ms().to_string())
                .into_bytes(),
        };
        std::fs::write(&path, bytes).expect("file");
        if let Some(age) = entry["age_ms"].as_u64() {
            let at = SystemTime::now() - Duration::from_millis(age);
            std::fs::OpenOptions::new().write(true).open(&path).expect("open").set_modified(at).expect("mtime");
        }
    }
}

/// path -> (kind, text of the two stamp files), `/`-separated.
fn tree(root: &Path) -> BTreeMap<String, (String, Option<String>)> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, (String, Option<String>)>) {
        for entry in std::fs::read_dir(dir).expect("dir").flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(root).expect("inside").to_string_lossy().replace('\\', "/");
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                out.insert(rel, ("dir".into(), None));
                walk(root, &path, out);
            } else {
                let text = (name == "active-version" || name == ".version-sha256").then(|| std::fs::read_to_string(&path).expect("text"));
                out.insert(rel, ("file".into(), text));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn normalised(text: &str, data: &Path, base: &str) -> String {
    let data = data.to_string_lossy();
    let text = text.replace(&data.replace('\\', "/"), "{data}").replace(&*data, "{data}").replace(base, "{base}");
    JsRegex::new_static(r"staging-\d+-\d+-[a-z0-9]+", "g").replace_all_with(&text, |_| "staging-{tag}".into())
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).expect("inside the data dir").to_string_lossy().replace('\\', "/")
}

#[tokio::test(flavor = "multi_thread")]
async fn installs_match_the_node_golden() {
    let golden = golden();
    let platform = platform_of(golden["recordedOn"].as_str().expect("platform"));
    let tokens = mixdog_rt::testing::tokens();
    for scenario in golden["install"].as_array().expect("installs") {
        let name = scenario["name"].as_str().expect("name");
        // These reach github.com in Node; the pure candidate test covers them.
        if name.starts_with("candidates-") || (!cfg!(windows) && name == "reinstall-zeroed-postgres") {
            continue;
        }
        let data = tempfile::tempdir().expect("data dir");
        apply_seed(data.path(), &scenario["seed"]);
        let server = stub(&scenario["serve"]).await;
        let manifest = Manifest::parse(&scenario["manifest"].to_string().replace("{base}", &server.base)).expect("manifest");
        let options = InstallOptions {
            data_dir: data.path().to_owned(),
            manifest,
            platform: platform.clone(),
            release_repositories: String::new(),
            durability: tokens.durability_io,
            bulk: tokens.cpu_bulk,
            now: system_now(),
            progress: None,
        };
        let outcome = ensure_runtime(&options, &CancellationToken::new()).await;

        let want = &scenario["outcome"];
        match (&outcome, want.get("ok"), want.get("error")) {
            (Ok(installed), Some(ok), _) => {
                assert_eq!(relative(data.path(), &installed.runtime_dir), ok["runtimeDir"].as_str().expect("dir"), "{name}: runtime dir");
                assert_eq!(relative(data.path(), &installed.pg_bin_dir), ok["pgBinDir"].as_str().expect("bin"), "{name}: bin");
                assert_eq!(relative(data.path(), &installed.lib_dir), ok["libDir"].as_str().expect("lib"), "{name}: lib");
                assert_eq!(relative(data.path(), &installed.share_path), ok["sharePath"].as_str().expect("share"), "{name}: share");
                assert_eq!(installed.version, ok["version"].as_str().expect("version"), "{name}: version");
            }
            (Err(error), _, Some(message)) => {
                assert_eq!(normalised(&error.to_string(), data.path(), &server.base), message.as_str().expect("message"), "{name}: error");
                // A platform the manifest cannot serve is "memory off", not a failure to retry.
                assert_eq!(matches!(error, RuntimeInstallError::Unavailable(_)), message.as_str().expect("message").contains("not available on"), "{name}: kind");
            }
            _ => panic!("{name}: got {outcome:?}, want {want}"),
        }

        let got: Vec<String> = server.requests.lock().expect("log").iter().map(|path| format!("{{base}}{path}")).collect();
        let want_requests: Vec<String> = scenario["requests"].as_array().expect("requests").iter().map(|r| r.as_str().expect("url").to_owned()).collect();
        assert_eq!(got, want_requests, "{name}: requests");

        let want_tree: BTreeMap<String, (String, Option<String>)> = scenario["tree"]
            .as_array()
            .expect("tree")
            .iter()
            .map(|e| (e["path"].as_str().expect("path").to_owned(), (e["kind"].as_str().expect("kind").to_owned(), e["text"].as_str().map(str::to_owned))))
            .collect();
        let got_tree: BTreeMap<String, (String, Option<String>)> = tree(data.path())
            .into_iter()
            .map(|(path, entry)| (normalised(&path, data.path(), &server.base), entry))
            .collect();
        assert_eq!(got_tree, want_tree, "{name}: tree");
    }
}

// ── Node's download timing (`bounded-download.mjs`), on paused time ─────────────────────────
// Scripted attempts, no sockets: with the clock paused a pending socket would let it jump.

fn secs(seconds: &[u64]) -> Vec<Duration> {
    seconds.iter().copied().map(Duration::from_secs).collect()
}

/// Runs `with_retry` over attempts that `script` answers (`None` hangs); returns the answer, the
/// time each attempt started and how many times the partial file was discarded.
async fn run_script(
    script: impl Fn(usize) -> Option<Result<u64, DownloadError>>,
    cancel: &CancellationToken,
    on_retry: impl Fn(usize, Duration, &DownloadError),
) -> (Result<u64, DownloadError>, Vec<Duration>, usize) {
    let start = tokio::time::Instant::now();
    let (starts, discards) = (Mutex::new(Vec::new()), Mutex::new(0usize));
    let result = with_retry(
        || {
            let n = {
                let mut starts = starts.lock().expect("starts");
                starts.push(start.elapsed());
                starts.len() - 1
            };
            let answer = script(n);
            async move {
                match answer {
                    Some(answer) => answer,
                    None => std::future::pending().await,
                }
            }
        },
        || async {
            *discards.lock().expect("discards") += 1;
        },
        cancel,
        on_retry,
    )
    .await;
    let (starts, discards) = (starts.into_inner().expect("starts"), discards.into_inner().expect("discards"));
    (result, starts, discards)
}

fn down() -> Option<Result<u64, DownloadError>> {
    Some(Err(DownloadError::Network("down".into())))
}

#[tokio::test(start_paused = true)]
async fn a_failing_download_waits_1_3_and_9_seconds_between_four_attempts() {
    let waits = Mutex::new(Vec::new());
    let (result, starts, discards) =
        run_script(|_| down(), &CancellationToken::new(), |n, wait, _| waits.lock().expect("waits").push((n, wait))).await;
    assert!(matches!(result, Err(DownloadError::Network(ref message)) if message == "down"), "{result:?}");
    assert_eq!(starts, secs(&[0, 1, 4, 13]));
    assert_eq!(*waits.lock().expect("waits"), [(1, Duration::from_secs(1)), (2, Duration::from_secs(3)), (3, Duration::from_secs(9))]);
    assert_eq!(discards, 0, "a failed attempt cleans up after itself");
}

#[tokio::test(start_paused = true)]
async fn a_4xx_answer_is_not_retried() {
    let http = || DownloadError::Http { status: 404, label: "x".into(), url: "u".into(), note: " (terminal)" };
    let (result, starts, _) = run_script(|_| Some(Err(http())), &CancellationToken::new(), |_, _, _| panic!("no wait")).await;
    assert!(matches!(result, Err(DownloadError::Http { status: 404, .. })));
    assert_eq!(starts, secs(&[0]));
}

#[tokio::test(start_paused = true)]
async fn a_5xx_answer_is_retried() {
    let http = || DownloadError::Http { status: 503, label: "x".into(), url: "u".into(), note: "" };
    let (result, starts, _) = run_script(|n| Some(if n < 2 { Err(http()) } else { Ok(9) }), &CancellationToken::new(), |_, _, _| {}).await;
    assert!(matches!(result, Ok(9)));
    assert_eq!(starts, secs(&[0, 1, 4]));
}

#[tokio::test(start_paused = true)]
async fn an_attempt_silent_for_180_seconds_is_abandoned_and_retried() {
    let (result, starts, discards) = run_script(|n| (n > 0).then_some(Ok(7)), &CancellationToken::new(), |_, _, _| {}).await;
    assert!(matches!(result, Ok(7)));
    assert_eq!(starts, secs(&[0, 181]), "180 s of the first attempt, then the 1 s wait");
    assert_eq!(discards, 1, "the partial file of the abandoned attempt is removed");
}

#[tokio::test(start_paused = true)]
async fn four_silent_attempts_end_with_node_timeout_text_after_733_seconds() {
    let start = tokio::time::Instant::now();
    let (result, starts, discards) = run_script(|_| None, &CancellationToken::new(), |_, _, _| {}).await;
    assert!(matches!(result, Err(DownloadError::Network(ref message)) if message == "The operation was aborted due to timeout"), "{result:?}");
    assert_eq!(starts, secs(&[0, 181, 364, 553]));
    assert_eq!(start.elapsed(), Duration::from_secs(733));
    assert_eq!(discards, 4);
}

#[tokio::test(start_paused = true)]
async fn a_cancel_ends_the_wait_between_attempts_at_once() {
    let cancel = CancellationToken::new();
    let trip = cancel.clone();
    let (result, starts, _) = run_script(|_| down(), &cancel, move |_, _, _| trip.cancel()).await;
    assert!(matches!(result, Err(DownloadError::Cancelled)));
    assert_eq!(starts, secs(&[0]));
}

#[tokio::test(start_paused = true)]
async fn a_cancel_ends_an_attempt_in_flight() {
    let cancel = CancellationToken::new();
    let trip = cancel.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        trip.cancel();
    });
    let start = tokio::time::Instant::now();
    let (result, starts, _) = run_script(|_| None, &cancel, |_, _, _| {}).await;
    canceller.await.expect("canceller");
    assert!(matches!(result, Err(DownloadError::Cancelled)));
    assert_eq!((starts, start.elapsed()), (secs(&[0]), Duration::from_secs(5)));
}

#[test]
fn the_archive_entry_checks_match_node() {
    let golden = golden();
    let base = std::env::temp_dir().join("stage").join("staging-x");
    for case in golden["tarEntries"].as_array().expect("cases") {
        let strings = |key: &str| -> Vec<String> { case[key].as_array().expect("list").iter().map(|s| s.as_str().expect("text").to_owned()).collect() };
        let got = match validate_entries(&strings("entries"), &strings("details"), &base) {
            Ok(()) => "ok".to_owned(),
            Err(message) => message,
        };
        assert_eq!(got, case["outcome"].as_str().expect("outcome"), "{}", case["name"]);
    }
}

#[test]
fn platform_candidates_match_node() {
    let golden = golden();
    for row in golden["platformKeys"].as_array().expect("rows") {
        let platform = Platform::new(row["platform"].as_str().expect("os"), row["arch"].as_str().expect("arch"));
        let want: Vec<&str> = row["candidates"].as_array().expect("candidates").iter().map(|c| c.as_str().expect("key")).collect();
        assert_eq!(platform.candidates(), want, "{}-{}", platform.os, platform.arch);
    }
}

/// The urls Node requested are the first candidates; when every one failed they are all of them.
#[test]
fn candidate_urls_match_the_node_requests() {
    let golden = golden();
    let mut compared = 0;
    for scenario in golden["install"].as_array().expect("installs") {
        let name = scenario["name"].as_str().expect("name");
        if !name.starts_with("candidates-") {
            continue;
        }
        let env = scenario["env"].as_object().expect("env");
        let repositories = repositories_env(|variable| env.get(variable).and_then(Value::as_str).map(str::to_owned));
        let url = scenario["manifest"]["assets"][golden["recordedOn"].as_str().expect("platform")]["url"].as_str().expect("url");
        let candidates = url_candidates(url, &repositories);
        let requested: Vec<&str> = scenario["requests"].as_array().expect("requests").iter().map(|r| r.as_str().expect("url")).collect();
        assert_eq!(candidates[..requested.len()], requested[..], "{name}");
        if name == "candidates-all-fail" {
            assert_eq!(candidates.len(), requested.len(), "{name}: every candidate was tried");
        }
        compared += 1;
    }
    assert_eq!(compared, 3);
}

#[test]
fn an_empty_first_variable_falls_through_to_the_second() {
    let read = |variable: &str| match variable {
        "MIXDOG_RUNTIME_RELEASE_REPOSITORY" => Some(String::new()),
        "RUNTIME_RELEASE_REPOSITORY" => Some("o/r".to_owned()),
        _ => None,
    };
    assert_eq!(repositories_env(read), "o/r");
    assert_eq!(repositories_env(|_| None), "");
}

#[test]
fn only_github_release_urls_have_fallback_repositories() {
    assert_eq!(url_candidates("http://127.0.0.1:1/a.tar.gz", "o/r"), ["http://127.0.0.1:1/a.tar.gz"]);
    assert_eq!(
        url_candidates("https://GitHub.com/a/b/releases/download/t/x.tar.gz", "o/r"),
        ["https://GitHub.com/a/b/releases/download/t/x.tar.gz"],
        "the repository path is replaced only where it is spelled as the pattern found it"
    );
}

#[test]
fn the_bundled_manifest_serves_every_platform_it_lists() {
    let manifest = Manifest::bundled().expect("bundled manifest");
    let text: Value = serde_json::from_str(include_str!("runtime-manifest.json")).expect("manifest json");
    for key in text["assets"].as_object().expect("assets").keys() {
        let (asset, selected) = manifest.select(&platform_of(key)).expect("a usable asset");
        assert_eq!(&selected, key);
        assert!(asset.url.starts_with("https://github.com/"), "{key}");
    }
}
