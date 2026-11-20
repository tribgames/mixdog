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
    async fn send(&self, request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
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
        let versions =
            ClientVersions::with_clock(transport.clone(), dir.path().to_owned(), io.clone(), Arc::new(TestEnv(HashMap::new())), Arc::new(|| 1_000_000_000_000));
        versions.warm(dialect).await;
        let seen = transport.seen();
        assert_eq!((seen[0].after, seen[0].text.as_str()), (std::time::Duration::from_secs(seconds), "The operation was aborted due to timeout"));
    }
}
