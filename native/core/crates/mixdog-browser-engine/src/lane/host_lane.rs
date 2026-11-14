//! Owner: s4-engine-lane
//! The host lane over the core's [`HostChannel`]: every `host/browser/*` request goes to the connection that claimed the desktop's
//! `BrowserEngine` capability, and its answer is returned only once the [`Mirror`] has seen everything the host pushed up to the
//! facts the answer carries (a result and the notifications before it travel separately, and the engine reads the ledgers after
//! the result). A `HostLane` is a [`HostWire`], so it is a [`BrowserHost`](crate::port::BrowserHost) with the typing and the error
//! mapping of `port`.
//!
//! - A result's `seq` is waited for [`FACTS_SEQ_WAIT`]; when the page's notifications skipped, or the wait ran out, the page is
//!   synced (`host/browser/page/sync`) and the mirror takes the facts it answers. A page the mirror has never heard of takes the
//!   result's facts as its first word.
//! - The caller's cancel abandons the request (the channel drops it), and the claim ending ([`EngineSink::host_gone`]) fails
//!   every command under it as unavailable: a command that began under one desktop's claim never finishes under another's.
//!
//! The console ledger's floor that `page/sync` also answers is not read: the ledgers here keep their own report marks.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::v2::browser_engine::BrowserBlobRef;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageSyncParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageSyncResult;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::host::CLAIMANT_CLOSED;
use mixdog_core_api::ids::Method;
use mixdog_rt::CancellationToken;
use mixdog_rt::Scope;
use mixdog_rt::Scoped;
use serde_json::Value;

use super::mirror::Caught;
use super::mirror::Mirror;
use crate::error::HostCallError;
use crate::port::BlobPort;
use crate::port::HostWire;

/// How long a result waits for the notifications the host sent before it, before the page is synced instead.
pub const FACTS_SEQ_WAIT: Duration = Duration::from_secs(2);

const PAGE_SYNC: &str = "host/browser/page/sync";
const PAGES_CLOSE: &str = "host/browser/pages/close";

pub struct HostLane {
    channel: Arc<dyn HostChannel>,
    blobs: Arc<dyn BlobPort>,
    mirror: Arc<Mirror>,
    seq_wait: Duration,
}

/// What a command that outlived its claim fails with.
fn claim_ended() -> HostCallError {
    HostCallError::Unavailable { detail: CLAIMANT_CLOSED.to_owned() }
}

/// The page facts an answer carries: its own `facts`, a resolved `page`'s, and each of a listing's `pages`.
fn facts_of(answer: &Value) -> Vec<PageFacts> {
    let mut found = Vec::new();
    let mut take = |value: Option<&Value>| {
        if let Some(facts) = value.and_then(|value| serde_json::from_value(value.clone()).ok()) {
            found.push(facts);
        }
    };
    take(answer.get("facts"));
    take(answer.get("page").and_then(|page| page.get("facts")));
    for page in answer.get("pages").and_then(Value::as_array).into_iter().flatten() {
        take(page.get("facts"));
    }
    found
}

impl HostLane {
    pub fn new(channel: Arc<dyn HostChannel>, blobs: Arc<dyn BlobPort>) -> Self {
        Self { channel, blobs, mirror: Arc::new(Mirror::new()), seq_wait: FACTS_SEQ_WAIT }
    }

    /// A lane whose results wait `wait` for their notifications.
    pub fn with_seq_wait(mut self, wait: Duration) -> Self {
        self.seq_wait = wait;
        self
    }

    /// The ledgers this lane keeps; the sink that feeds them is `EngineSinkImpl::new(lane.mirror().clone(), hold)`.
    pub fn mirror(&self) -> &Arc<Mirror> {
        &self.mirror
    }

    /// A payload the host left in its blob store by digest (a large screenshot or a download).
    pub async fn read_blob(&self, blob: &BrowserBlobRef) -> Result<Bytes, HostCallError> {
        self.blobs.read(&blob.digest).await.map_err(|message| HostCallError::Failed { message })
    }

    /// One request, as the channel answers it, under `claim`.
    async fn exchange(&self, method: &'static str, params: Value, cancel: &CancellationToken, claim: &CancellationToken) -> Result<Value, HostCallError> {
        let sent = self.channel.request_scoped(HostCapability::BrowserEngine, Method(method), params, cancel);
        let Scoped::Done(answer) = Scope::new().cancel(claim).run(sent).await else {
            return Err(claim_ended());
        };
        if claim.is_cancelled() {
            return Err(claim_ended());
        }
        answer.map_err(HostCallError::from)
    }

    /// Returns when the mirror holds everything the host pushed up to `facts.seq`.
    async fn reach(&self, facts: &PageFacts, cancel: &CancellationToken, claim: &CancellationToken) -> Result<(), HostCallError> {
        let waited = Scope::new().cancel(cancel).within(self.seq_wait).run(self.mirror.caught_up(&facts.page_id, facts.seq)).await;
        if claim.is_cancelled() {
            return Err(claim_ended());
        }
        match waited {
            Scoped::Cancelled => Err(HostCallError::Cancelled),
            Scoped::Done(Caught::Up) => Ok(()),
            Scoped::Done(Caught::Unseen) => {
                if self.mirror.resync(claim, facts) { Ok(()) } else { Err(claim_ended()) }
            }
            Scoped::Done(Caught::Gapped) | Scoped::DeadlineExceeded => self.sync(&facts.page_id, cancel, claim).await,
        }
    }

    /// `host/browser/page/sync`: the mirror takes the page's facts as the host holds them now.
    async fn sync(&self, page_id: &str, cancel: &CancellationToken, claim: &CancellationToken) -> Result<(), HostCallError> {
        let params = serde_json::to_value(HostBrowserPageSyncParams { page_id: page_id.to_owned() })
            .map_err(|error| HostCallError::Failed { message: format!("{PAGE_SYNC}: params do not serialize: {error}") })?;
        let answer = match self.exchange(PAGE_SYNC, params, cancel, claim).await {
            Ok(answer) => answer,
            // The page closed after it answered: there is nothing left to catch up with.
            Err(HostCallError::PageGone) => {
                self.mirror.forget(page_id);
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let synced: HostBrowserPageSyncResult =
            serde_json::from_value(answer).map_err(|error| HostCallError::Failed { message: format!("{PAGE_SYNC}: malformed answer: {error}") })?;
        if self.mirror.resync(claim, &synced.facts) { Ok(()) } else { Err(claim_ended()) }
    }
}

#[async_trait]
impl HostWire for HostLane {
    async fn call(&self, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, HostCallError> {
        let claim = self.mirror.claim();
        let closing = if method == PAGES_CLOSE { params.get("pageId").and_then(Value::as_str).map(str::to_owned) } else { None };
        match self.exchange(method, params, cancel, &claim).await {
            Ok(answer) => {
                for facts in facts_of(&answer) {
                    self.reach(&facts, cancel, &claim).await?;
                }
                if let Some(page_id) = closing
                    && answer.get("closed").and_then(Value::as_bool) == Some(true)
                {
                    self.mirror.forget(&page_id);
                }
                Ok(answer)
            }
            Err(error) => {
                // A refused precondition names the page's facts as they are: the engine reads the ledgers to explain it.
                if let HostCallError::PreconditionFailed { facts, .. } = &error {
                    self.reach(facts, cancel, &claim).await?;
                }
                Err(error)
            }
        }
    }

    fn notify(&self, method: &'static str, params: Value) -> Result<(), HostCallError> {
        self.channel.notify(HostCapability::BrowserEngine, Method(method), params).map_err(|error| HostCallError::from(HostError::from(error)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::page_facts;
    use crate::lane::sink::EngineSinkImpl;
    use crate::port::BrowserHost;
    use crate::port::EngineSink;
    use crate::queue::user_hold::UserHold;
    use mixdog_app_protocol::v2::browser_engine::BrowserPageCloseReason;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserEventsParams;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserLeaseReleaseParams;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserPageFactsParams;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserPageStopParams;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserPagesCloseParams;
    use mixdog_core_api::CoreError;
    use serde_json::json;
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    use tokio::task::yield_now;

    enum Reply {
        Result(Value),
        Rpc(i64),
        /// Never answers.
        Hang,
    }

    /// Sets its flag when the request that holds it is dropped.
    struct Abandoned(Arc<AtomicBool>);

    impl Drop for Abandoned {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// An in-memory `HostChannel`: answers by method from a script, records what it was asked.
    #[derive(Default)]
    struct Script {
        replies: Mutex<HashMap<&'static str, VecDeque<Reply>>>,
        calls: Mutex<Vec<&'static str>>,
        notes: Mutex<Vec<(&'static str, Value)>>,
        abandoned: Arc<AtomicBool>,
    }

    impl Script {
        fn reply(&self, method: &'static str, reply: Reply) {
            self.replies.lock().unwrap().entry(method).or_default().push_back(reply);
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }

        fn abandoned(&self) -> bool {
            self.abandoned.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl HostChannel for Script {
        async fn request(&self, capability: HostCapability, method: Method, _params: Value) -> Result<Value, HostError> {
            assert_eq!(capability, HostCapability::BrowserEngine);
            self.calls.lock().unwrap().push(method.0);
            let reply = self.replies.lock().unwrap().get_mut(method.0).and_then(VecDeque::pop_front).expect("a scripted reply");
            match reply {
                Reply::Result(value) => Ok(value),
                Reply::Rpc(code) => Err(HostError::Rpc { code, message: String::new(), data: None }),
                Reply::Hang => {
                    let _abandoned = Abandoned(self.abandoned.clone());
                    std::future::pending().await
                }
            }
        }

        fn notify(&self, capability: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
            assert_eq!(capability, HostCapability::BrowserEngine);
            self.notes.lock().unwrap().push((method.0, params));
            Ok(())
        }
    }

    struct Blobs;

    #[async_trait]
    impl BlobPort for Blobs {
        async fn read(&self, digest: &str) -> Result<Bytes, String> {
            if digest == "d1" { Ok(Bytes::from_static(b"pixels")) } else { Err(format!("no blob {digest}")) }
        }
    }

    fn rig() -> (HostLane, Arc<Script>, EngineSinkImpl) {
        let script = Arc::new(Script::default());
        let lane = HostLane::new(script.clone(), Arc::new(Blobs));
        let sink = EngineSinkImpl::new(lane.mirror().clone(), Arc::new(UserHold::new()));
        (lane, script, sink)
    }

    fn facts_result(page: &str, seq: u64) -> Reply {
        Reply::Result(json!({"facts": page_facts(page, seq)}))
    }

    fn events(page: &str, seq: u64) -> HostBrowserEventsParams {
        serde_json::from_value(json!({"pageId": page, "seq": seq, "events": []})).expect("events")
    }

    fn facts_push(page: &str, seq: u64) -> HostBrowserPageFactsParams {
        HostBrowserPageFactsParams { page_id: page.into(), seq, facts: serde_json::from_value(page_facts(page, seq)).expect("facts") }
    }

    fn stop(page: &str) -> HostBrowserPageStopParams {
        HostBrowserPageStopParams { page_id: page.into() }
    }

    const STOP: &str = "host/browser/page/stop";

    #[tokio::test]
    async fn a_result_waits_for_the_notifications_up_to_its_seq() {
        let (lane, script, sink) = rig();
        script.reply(STOP, facts_result("p1", 4));
        sink.events(events("p1", 2));
        let token = CancellationToken::new();
        let pushed = AtomicBool::new(false);
        let command = async {
            let result = lane.page_stop(stop("p1"), &token).await;
            (result, pushed.load(Ordering::SeqCst))
        };
        let driver = async {
            for _ in 0..3 {
                yield_now().await;
            }
            pushed.store(true, Ordering::SeqCst);
            sink.events(events("p1", 3));
            sink.facts(facts_push("p1", 4));
        };
        let ((result, waited), ()) = tokio::join!(command, driver);
        assert_eq!(result.expect("answered").facts.seq, 4);
        assert!(waited, "the result returned before its notifications arrived");
        assert_eq!(lane.mirror().cursor("p1"), Some(4));
        assert_eq!(script.calls(), vec![STOP], "no sync was needed");
    }

    #[tokio::test]
    async fn a_gap_is_synced_at_once() {
        let script = Arc::new(Script::default());
        let lane = HostLane::new(script.clone(), Arc::new(Blobs)).with_seq_wait(Duration::from_secs(30));
        let sink = EngineSinkImpl::new(lane.mirror().clone(), Arc::new(UserHold::new()));
        sink.events(events("p1", 2));
        sink.events(events("p1", 5));
        assert_eq!(lane.mirror().cursor("p1"), Some(2), "a batch after a gap is not applied");
        script.reply(STOP, facts_result("p1", 6));
        script.reply(PAGE_SYNC, Reply::Result(json!({"facts": page_facts("p1", 6), "consoleFloor": 0})));
        let started = std::time::Instant::now();
        lane.page_stop(stop("p1"), &CancellationToken::new()).await.expect("answered");
        assert!(started.elapsed() < Duration::from_secs(5), "a gap does not wait out the bound");
        assert_eq!(script.calls(), vec![STOP, PAGE_SYNC]);
        assert_eq!(lane.mirror().cursor("p1"), Some(6));
        sink.events(events("p1", 7));
        assert_eq!(lane.mirror().cursor("p1"), Some(7), "the page takes notifications again after the sync");
    }

    #[tokio::test]
    async fn notifications_that_never_come_end_in_a_sync_after_the_bound() {
        let script = Arc::new(Script::default());
        let lane = HostLane::new(script.clone(), Arc::new(Blobs)).with_seq_wait(Duration::from_millis(30));
        let sink = EngineSinkImpl::new(lane.mirror().clone(), Arc::new(UserHold::new()));
        sink.events(events("p1", 3));
        script.reply(STOP, facts_result("p1", 5));
        script.reply(PAGE_SYNC, Reply::Result(json!({"facts": page_facts("p1", 5), "consoleFloor": 0})));
        lane.page_stop(stop("p1"), &CancellationToken::new()).await.expect("answered");
        assert_eq!(script.calls(), vec![STOP, PAGE_SYNC]);
        assert_eq!(lane.mirror().cursor("p1"), Some(5));
    }

    #[tokio::test]
    async fn a_page_the_mirror_never_heard_of_starts_at_the_results_facts() {
        let (lane, script, sink) = rig();
        script.reply(STOP, facts_result("p9", 9));
        lane.page_stop(stop("p9"), &CancellationToken::new()).await.expect("answered");
        assert_eq!(script.calls(), vec![STOP]);
        assert_eq!(lane.mirror().cursor("p9"), Some(9));
        sink.events(events("p9", 10));
        assert_eq!(lane.mirror().cursor("p9"), Some(10));
    }

    #[tokio::test]
    async fn a_cancel_abandons_the_request() {
        let (lane, script, _sink) = rig();
        script.reply(STOP, Reply::Hang);
        let token = CancellationToken::new();
        let driver = async {
            yield_now().await;
            token.cancel();
        };
        let (result, ()) = tokio::join!(lane.page_stop(stop("p1"), &token), driver);
        assert_eq!(result.unwrap_err(), HostCallError::Cancelled);
        assert!(script.abandoned());
    }

    #[tokio::test]
    async fn a_dropped_command_abandons_the_request() {
        let (lane, script, _sink) = rig();
        script.reply(STOP, Reply::Hang);
        let token = CancellationToken::new();
        let outcome = mixdog_rt::time::timeout(Duration::from_millis(20), lane.page_stop(stop("p1"), &token)).await;
        assert!(outcome.is_err(), "the host never answered");
        assert!(script.abandoned());
    }

    #[tokio::test]
    async fn the_host_going_away_fails_the_command_in_flight_and_drops_the_pages() {
        let (lane, script, sink) = rig();
        sink.events(events("p1", 2));
        script.reply(STOP, Reply::Hang);
        let token = CancellationToken::new();
        let driver = async {
            yield_now().await;
            sink.host_gone();
        };
        let (result, ()) = tokio::join!(lane.page_stop(stop("p1"), &token), driver);
        assert_eq!(result.unwrap_err(), HostCallError::Unavailable { detail: CLAIMANT_CLOSED.to_owned() });
        assert!(script.abandoned());
        assert_eq!(lane.mirror().cursor("p1"), None);
        // The next claimant is served under a claim of its own.
        script.reply(STOP, facts_result("p2", 1));
        lane.page_stop(stop("p2"), &token).await.expect("answered");
        assert_eq!(lane.mirror().cursor("p2"), Some(1));
    }

    #[tokio::test]
    async fn the_host_going_away_while_a_result_waits_for_its_notifications_fails_it() {
        let (lane, script, sink) = rig();
        sink.events(events("p1", 2));
        script.reply(STOP, facts_result("p1", 8));
        let token = CancellationToken::new();
        let driver = async {
            yield_now().await;
            yield_now().await;
            sink.host_gone();
        };
        let (result, ()) = tokio::join!(lane.page_stop(stop("p1"), &token), driver);
        assert_eq!(result.unwrap_err(), HostCallError::Unavailable { detail: CLAIMANT_CLOSED.to_owned() });
        assert_eq!(lane.mirror().cursor("p1"), None, "a dead claim's page is not kept");
    }

    #[tokio::test]
    async fn host_errors_map_by_code() {
        let (lane, script, _sink) = rig();
        script.reply(STOP, Reply::Rpc(-32011));
        assert_eq!(lane.page_stop(stop("p1"), &CancellationToken::new()).await.unwrap_err(), HostCallError::PageGone);
    }

    /// A host that refuses every request with a failed precondition carrying `data`.
    struct Precondition(Value);

    #[async_trait]
    impl HostChannel for Precondition {
        async fn request(&self, _capability: HostCapability, _method: Method, _params: Value) -> Result<Value, HostError> {
            Err(HostError::Rpc { code: -32010, message: String::new(), data: Some(self.0.clone()) })
        }

        fn notify(&self, _capability: HostCapability, _method: Method, _params: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_refused_precondition_is_returned_after_its_facts_are_in() {
        let data = json!({"reason": "document", "facts": page_facts("p1", 3)});
        let lane = HostLane::new(Arc::new(Precondition(data)), Arc::new(Blobs));
        let sink = EngineSinkImpl::new(lane.mirror().clone(), Arc::new(UserHold::new()));
        sink.events(events("p1", 2));
        let token = CancellationToken::new();
        let driver = async {
            yield_now().await;
            sink.events(events("p1", 3));
        };
        let (result, ()) = tokio::join!(lane.page_stop(stop("p1"), &token), driver);
        match result.unwrap_err() {
            HostCallError::PreconditionFailed { facts, .. } => assert_eq!(facts.seq, 3),
            other => panic!("{other:?}"),
        }
        assert_eq!(lane.mirror().cursor("p1"), Some(3));
    }

    #[tokio::test]
    async fn closing_a_page_drops_its_ledgers() {
        let (lane, script, sink) = rig();
        sink.events(events("p1", 1));
        script.reply(PAGES_CLOSE, Reply::Result(json!({"closed": true})));
        let params = HostBrowserPagesCloseParams { page_id: "p1".into(), reason: BrowserPageCloseReason::Agent };
        assert!(lane.pages_close(params, &CancellationToken::new()).await.expect("answered").closed);
        assert_eq!(lane.mirror().cursor("p1"), None);
    }

    #[tokio::test]
    async fn the_lease_release_is_a_notification() {
        let (lane, script, _sink) = rig();
        lane.lease_release(HostBrowserLeaseReleaseParams { page_id: "p1".into(), lease_id: "l1".into() }).expect("sent");
        assert_eq!(*script.notes.lock().unwrap(), vec![("host/browser/lease/release", json!({"pageId": "p1", "leaseId": "l1"}))]);
        assert!(script.calls().is_empty());
    }

    #[tokio::test]
    async fn a_blob_is_read_by_digest() {
        let (lane, _script, _sink) = rig();
        assert_eq!(lane.read_blob(&BrowserBlobRef { digest: "d1".into(), size: 6 }).await.expect("read"), Bytes::from_static(b"pixels"));
        assert_eq!(
            lane.read_blob(&BrowserBlobRef { digest: "d2".into(), size: 0 }).await.unwrap_err(),
            HostCallError::Failed { message: "no blob d2".into() }
        );
    }
}
