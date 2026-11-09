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

const GOLDEN: &str = include_str!("../../../fixtures/client-versions/golden.json");

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

pub(crate) fn versions_in(dir: &std::path::Path, net: &Arc<Net>, env: HashMap<String, String>, clock: &Arc<AtomicU64>) -> Arc<ClientVersions> {
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let now = Arc::clone(clock);
    ClientVersions::with_clock(net.clone(), dir.to_owned(), io, Arc::new(TestEnv(env)), Arc::new(move || now.load(Ordering::SeqCst)))
}

fn dialect(name: &str) -> Dialect {
    match name {
        "codex" => Dialect::Codex,
        "grok" => Dialect::Grok,
        "cursor" => Dialect::Cursor,
        _ => Dialect::Antigravity,
    }
}

fn present(versions: &ClientVersions, name: &str) -> String {
    match name {
        "codex" => versions.codex(),
        "grok" => versions.grok(),
        "cursor" => versions.cursor(),
        _ => versions.antigravity(),
    }
}

#[tokio::test]
async fn the_dialects_fetch_cache_remember_and_present_versions_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let base = golden["base"].as_u64().unwrap();
    assert!(golden["scenarios"].as_array().unwrap().len() >= 20);
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let env: HashMap<String, String> =
            scenario["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
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
                    assert_eq!(Value::String(present(&versions, which)), want["version"], "{ctx} version");
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
            assert_eq!(*net.log.lock().unwrap(), fetched, "{ctx} fetched");
        }
    }
}

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

/// `warmCliVersion` (`anthropic-oauth-client-version.mjs`): the claude-code package's npm `latest` is asked before the
/// OAuth listing continues, unless `MIXDOG_CLI_VERSION` names the version. This is why Node's cold `anthropic-oauth`
/// listing outlives the catalog's 4 s deadline when the registry cannot be reached.
#[tokio::test]
async fn the_claude_dialect_warms_the_claude_code_package_unless_the_version_is_named() {
    for (env, asked) in [(HashMap::new(), 1), (HashMap::from([("MIXDOG_CLI_VERSION".to_owned(), "2.1.400".to_owned())]), 0)] {
        let dir = tempfile::tempdir().unwrap();
        let net = Arc::new(Net::default());
        let versions = versions_in(dir.path(), &net, env, &Arc::new(AtomicU64::new(1_000_000)));
        versions.warm(Dialect::Claude).await;
        let log = net.log.lock().unwrap();
        assert_eq!(log.len(), asked);
        if asked == 1 {
            assert_eq!(log[0].0, "https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
        }
    }
}
