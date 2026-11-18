//! The live client versions against Node's own modules (`record-client-versions.mjs`): the same
//! fetches at the same times, and the version each dialect then presents.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use serde_json::Value;

use super::*;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;

pub(crate) struct TestEnv(pub HashMap<String, String>);

impl Environment for TestEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// The scripted network: each request is logged, and answered from the queue (an empty queue or a
/// `fail` entry is a connection that never opens).
#[derive(Default)]
pub(crate) struct Net {
    pub log: Mutex<Vec<(String, BTreeMap<String, String>)>>,
    pub queue: Mutex<VecDeque<Value>>,
}

#[async_trait]
impl HttpSend for Net {
    async fn send(
        &self,
        request: WireRequest,
        _exchange: crate::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        assert_eq!(request.method, "GET");
        let headers = request.headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
        self.log.lock().unwrap().push((request.url, headers));
        let next = self.queue.lock().unwrap().pop_front();
        match next {
            Some(answer) if answer["fail"] != true => Ok(HttpResponse {
                status: answer["status"].as_u64().unwrap() as u16,
                headers: Vec::new(),
                body: Box::new(Body(Some(Bytes::from(answer["body"].as_str().unwrap().to_owned())))),
            }),
            _ => Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent)),
        }
    }
}

#[cfg(node_twin)]
fn dialect(name: &str) -> Dialect {
    match name {
        "codex" => Dialect::Codex,
        "grok" => Dialect::Grok,
        "cursor" => Dialect::Cursor,
        _ => Dialect::Antigravity,
    }
}

#[cfg(node_twin)]
fn present(versions: &ClientVersions, name: &str) -> String {
    match name {
        "codex" => versions.codex(),
        "grok" => versions.grok(),
        "cursor" => versions.cursor(),
        _ => versions.antigravity(),
    }
}

/// A manifest answering a version below the pinned floor is not believed; the floor itself and anything newer is.
#[test]
fn an_update_manifest_below_the_pinned_floor_is_rejected() {
    use crate::providers::google::auth::antigravity::VERSION_FALLBACK;
    assert!(!antigravity_version_acceptable("2.19.1"));
    assert!(!antigravity_version_acceptable("2.31.9"));
    assert!(antigravity_version_acceptable(VERSION_FALLBACK));
    assert!(antigravity_version_acceptable("2.33.0"));
    assert!(antigravity_version_acceptable("10.0.0"));
}

pub(crate) fn versions_in(dir: &std::path::Path, net: &Arc<Net>, env: HashMap<String, String>, clock: &Arc<AtomicU64>) -> Arc<ClientVersions> {
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let now = Arc::clone(clock);
    ClientVersions::with_clock(net.clone(), dir.to_owned(), io, Arc::new(TestEnv(env)), Arc::new(move || now.load(Ordering::SeqCst)))
}
/// `readLastKnownVersion` accepts only its own schema and a plain token; `rememberLastKnownVersion`
/// keeps the other clients' entries.
#[tokio::test]
async fn the_remembered_file_keeps_each_clients_entry_and_refuses_foreign_content() {
    let dir = tempfile::tempdir().unwrap();
    let net = Arc::new(Net::default());
    let clock = Arc::new(AtomicU64::new(7));
    let store = versions_in(dir.path(), &net, HashMap::new(), &clock);
    let known = LastKnown::new(
        dir.path().to_owned(),
        {
            let tokens = mixdog_rt::testing::tokens();
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
        },
        Arc::new(TestEnv(HashMap::new())),
        Arc::new(|| 7),
    );
    drop(store);
    known.remember("codex-cli", Some("0.170.0")).await;
    known.remember("grok-cli", Some("1.0.80")).await;
    known.remember("bad", Some("has space")).await;
    assert_eq!(known.read("codex-cli").await.as_deref(), Some("0.170.0"));
    assert_eq!(known.read("grok-cli").await.as_deref(), Some("1.0.80"));
    assert_eq!(known.read("bad").await, None);
    let file: Value = serde_json::from_slice(&mixdog_statefile::read_content(&dir.path().join(LAST_KNOWN_FILE)).unwrap().unwrap()).unwrap();
    assert_eq!(file["version"], 1);
    assert_eq!(file["entries"]["codex-cli"], serde_json::json!({ "value": "0.170.0", "fetchedAt": 7 }));
    known.remember("codex-cli", None).await;
    assert_eq!(known.read("codex-cli").await, None);
    assert_eq!(known.read("grok-cli").await.as_deref(), Some("1.0.80"));
    // Another build's schema is nobody's data.
    use mixdog_rt::LaneToken as _;
    let other = dir.path().join(LAST_KNOWN_FILE);
    mixdog_rt::testing::tokens()
        .durability_io
        .submit(&tokio_util::sync::CancellationToken::new(), move |lane| {
            mixdog_statefile::write_file(lane, &other, br#"{"version":2,"entries":{"grok-cli":{"value":"1.0.80"}}}"#, &mixdog_statefile::Opts::default())
        })
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(known.read("grok-cli").await, None);
}

/// The lookups that outlive their timers end at their windows: the npm read at 4 s and the update manifest at 5 s.
#[tokio::test(start_paused = true)]
async fn a_lookup_that_outlives_its_timer_ends_at_its_window() {
    use crate::transport::site_probe::TimingOut;

    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    for (dialect, seconds) in [(Dialect::Codex, 4), (Dialect::Antigravity, 5)] {
        let dir = tempfile::tempdir().unwrap();
        let transport = TimingOut::new();
        let versions = ClientVersions::with_clock(transport.clone(), dir.path().to_owned(), io.clone(), Arc::new(TestEnv(HashMap::new())), Arc::new(|| 1_000_000_000_000));
        versions.warm(dialect).await;
        let seen = transport.seen();
        assert_eq!((seen[0].after, seen[0].text.as_str()), (std::time::Duration::from_secs(seconds), "The operation was aborted due to timeout"));
    }
}

#[cfg(node_twin)]
const GOLDEN: &str = include_str!("../../../fixtures/client-versions/golden.json");
#[cfg(node_twin)]
#[tokio::test]
async fn the_dialects_fetch_cache_remember_and_present_versions_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let base = golden["base"].as_u64().unwrap();
    assert!(golden["scenarios"].as_array().unwrap().len() >= 20);
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let env: HashMap<String, String> =
            scenario["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        // Decided departure from the recording: an Antigravity update manifest answering less than the pinned fallback (the floor the
        // service needs for current models) is not believed, so the version presented is the floor and the rejected answer is not
        // remembered; the fetches that follow it are then not Node's. The recording stays as recorded: such a scenario is replayed
        // with the floored versions and its fetch log is not compared.
        let floor = crate::providers::google::auth::antigravity::VERSION_FALLBACK;
        let below_floor = |recorded: &Value| env.get("MIXDOG_ANTIGRAVITY_VERSION").is_none() && recorded.as_str().is_some_and(|v| is_semver(v) && compare_semver(v, floor) == std::cmp::Ordering::Less);
        let departed = scenario["steps"]
            .as_array()
            .unwrap()
            .iter()
            .zip(scenario["trace"].as_array().unwrap())
            .any(|(step, want)| step["dialect"].as_str() == Some("antigravity") && below_floor(&want["version"]));
        if departed {
            eprintln!("DEPARTED client-versions {name}: an Antigravity manifest below the pinned floor {floor} is rejected");
        }
        let dir = tempfile::tempdir().unwrap();
        let net = Arc::new(Net::default());
        let clock = Arc::new(AtomicU64::new(base));
        let mut versions = versions_in(dir.path(), &net, env.clone(), &clock);
        for (step, want) in scenario["steps"].as_array().unwrap().iter().zip(scenario["trace"].as_array().unwrap()) {
            let ctx = format!("{name} @{}", step["at"]);
            clock.store(base + step["at"].as_u64().unwrap(), Ordering::SeqCst);
            net.log.lock().unwrap().clear();
            *net.queue.lock().unwrap() = step["net"].as_array().cloned().unwrap_or_default().into();
            match step["do"].as_str().unwrap() {
                "restart" => {
                    // A new process: nothing in memory, the data directory kept.
                    versions = versions_in(dir.path(), &net, env.clone(), &clock);
                }
                "learn" => {
                    let learned = versions.learn_grok_required(step["text"].as_str().unwrap_or(""));
                    assert_eq!(Value::Bool(learned), want["learned"], "{ctx} learned");
                    assert_eq!(Value::String(versions.grok()), want["version"], "{ctx} grok version");
                }
                _ => {
                    let which = step["dialect"].as_str().unwrap();
                    let times = step["concurrent"].as_u64().unwrap_or(1);
                    futures::future::join_all((0..times).map(|_| versions.warm(dialect(which)))).await;
                    let wanted = if departed && which == "antigravity" && below_floor(&want["version"]) { Value::String(floor.to_owned()) } else { want["version"].clone() };
                    assert_eq!(Value::String(present(&versions, which)), wanted, "{ctx} version");
                }
            }
            let fetched: Vec<(String, BTreeMap<String, String>)> = want["fetched"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| {
                    let headers = f["headers"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
                    (f["url"].as_str().unwrap().to_owned(), headers)
                })
                .collect();
            if !departed {
                assert_eq!(*net.log.lock().unwrap(), fetched, "{ctx} fetched");
            }
        }
    }
}
#[cfg(node_twin)]
#[test]
fn the_pure_helpers_answer_as_nodes_do() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let helpers = &golden["helpers"];
    for case in helpers["maxSemver"].as_array().unwrap() {
        let candidates: Vec<Option<&str>> = case["candidates"].as_array().unwrap().iter().map(Value::as_str).collect();
        assert_eq!(max_semver(&candidates).map(Value::String).unwrap_or(Value::Null), case["result"], "{case}");
    }
    for case in helpers["manifest"].as_array().unwrap() {
        let got = parse_antigravity_manifest_version(case["input"].as_str().unwrap());
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), case["result"], "{case}");
    }
    for case in helpers["cursorBuild"].as_array().unwrap() {
        let got = parse_cursor_install_build(case["input"].as_str().unwrap());
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), case["result"], "{case}");
    }
    for case in helpers["cursorNewer"].as_array().unwrap() {
        let got = cursor_build_newer(case["next"].as_str().unwrap(), case["current"].as_str().unwrap());
        assert_eq!(Value::Bool(got), case["result"], "{case}");
    }
    for case in helpers["npmLatest"].as_array().unwrap() {
        let got = parse_npm_latest(case["input"].as_str().unwrap());
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), case["result"], "{case}");
    }
}
/// Node's cold `anthropic-oauth` listing with no credential (`record-claude-oauth-cold-listing.mjs`): `ensureAuth` awaits
/// `warmCliVersion` (the claude-code package's npm `latest`, unless `MIXDOG_CLI_VERSION` names the version) before it
/// finds no credential, and `listModels` answers its offline rows. Rust's source for the route, over the same scripted
/// network, makes the same requests in the same order and answers the same rows.
#[cfg(node_twin)]
#[tokio::test]
async fn a_cold_claude_oauth_listing_asks_and_answers_as_nodes() {
    use crate::catalog::{ModelSource, OauthModelCache};
    use crate::oauth::CredentialFile;
    use crate::providers::anthropic::{AnthropicAdapter, AnthropicConfig, OAuthSession};
    use crate::registry::versioned::VersionedAdapter;

    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/claude-oauth-cold-listing/golden.json")).unwrap();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let net = Arc::new(Net::default());
        net.queue.lock().unwrap().extend(scenario["net"].as_array().unwrap().iter().cloned());
        let env = scenario["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        let versions = versions_in(dir.path(), &net, env, &Arc::new(AtomicU64::new(1_800_000_000_000)));
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let session = OAuthSession::new(CredentialFile::new(dir.path().join("anthropic-oauth-credentials.json"), io.clone()), net.clone());
        let adapter = AnthropicAdapter::oauth(AnthropicConfig::new(Arc::new(|_: &str| None)), net.clone(), Arc::new(session), false, tokens.cpu_bulk);
        let wrapped = VersionedAdapter::wrap(Arc::new(adapter), Dialect::Claude, versions);
        let source = ModelSource::of_adapter("anthropic-oauth".into(), wrapped)
            .unwrap()
            .with_oauth_cache(OauthModelCache::new(dir.path().join("data"), io));
        let rows: Vec<Value> = source
            .list()
            .await
            .unwrap()
            .iter()
            .map(|r| {
                serde_json::json!({
                    "id": r.id,
                    "name": r.name,
                    "provider": r.provider.as_str(),
                    "family": r.family,
                    "contextWindow": r.context_window,
                    "display": r.display_name,
                    "tier": r.picker.tier,
                    "latest": r.picker.latest,
                })
            })
            .collect();
        let fetched: Vec<Value> =
            net.log.lock().unwrap().iter().map(|(url, _)| serde_json::json!({ "method": "GET", "url": url })).collect();
        assert_eq!(Value::Array(fetched), scenario["fetched"], "{name}: requests");
        assert_eq!(Value::Array(rows), scenario["rows"], "{name}: rows");
    }
}
#[cfg(node_twin)]
const CURSOR_CASES: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/cursor-client-version-cases/golden.json");
/// `providers/cursor-client-version.test.mjs` recorded from the reference tree (`cursor-client-version-cases`): the installer
/// answer, the environment and the warms of each case are the recorded ones; the version presented, the floor and the URLs
/// fetched are compared with Node's.
#[cfg(node_twin)]
#[tokio::test]
async fn the_cursor_version_follows_the_recorded_node_cases() {
    let recorded = mixdog_testkit::Exact::decode(&serde_json::from_str(&CURSOR_CASES).unwrap()).unwrap();
    assert_eq!(recorded.get("cases").as_array().len(), 7);
    for case in recorded.get("cases").as_array() {
        let name = case.get("case").as_str();
        let input = case.get("input").to_plain().unwrap();
        let env: HashMap<String, String> = input["env"]
            .as_object()
            .map(|env| env.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect())
            .unwrap_or_default();
        let answer = &input["answer"];
        // Node's scripted `fetch` answers every call alike; a throw is a connection that never opens
        let entry = match answer["throws"].is_string() {
            true => serde_json::json!({"fail": true}),
            false => serde_json::json!({"status": answer["status"].as_u64().unwrap_or(200), "body": answer["body"]}),
        };
        let dir = tempfile::tempdir().unwrap();
        let net = Arc::new(Net::default());
        *net.queue.lock().unwrap() = std::iter::repeat_n(entry, 8).collect();
        let clock = Arc::new(AtomicU64::new(1_800_000_000_000));
        let versions = versions_in(dir.path(), &net, env, &clock);
        for concurrent in input["warms"].as_array().unwrap() {
            futures::future::join_all((0..concurrent.as_u64().unwrap()).map(|_| versions.warm(Dialect::Cursor))).await;
        }
        let observed = case.get("observed");
        assert_eq!(versions.cursor(), observed.get("version").as_str(), "{name}: version");
        assert_eq!(CURSOR_CLIENT_VERSION_FLOOR, observed.get("floor").as_str(), "{name}: floor");
        let fetched: Vec<String> = net.log.lock().unwrap().iter().map(|(url, _)| url.clone()).collect();
        let expected: Vec<&str> = observed.get("calls").as_array().iter().map(|c| c.as_str()).collect();
        assert_eq!(fetched, expected, "{name}: fetched");
    }
}
