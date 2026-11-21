use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::Caller;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;

use super::Client;
use super::Rig;
use super::settle;
use crate::param_refs::ParamRefs;

/// What the core saw of one applied `host/state/set`: its connection, key and tag, and whether the connection was the
/// visualize claimant when it was applied.
#[derive(Clone, Debug, PartialEq)]
struct Applied {
    conn: u64,
    key: String,
    tag: String,
    current: bool,
}

#[derive(Default)]
struct Recorder {
    log: Mutex<Vec<Applied>>,
}

#[async_trait]
impl DomainService for Recorder {
    fn methods(&self) -> &'static [&'static str] {
        &["host/state/set"]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let conn = match &req.ctx.caller {
            Caller::Connection(id) => id.0,
            _ => 0,
        };
        self.log.lock().unwrap().push(Applied {
            conn,
            key: req.params["key"].as_str().unwrap_or_default().to_owned(),
            tag: req.params["value"]["tab"].as_str().unwrap_or_default().to_owned(),
            current: req.ctx.visualize_claim.is_current(),
        });
        Ok(Reply::Value(json!({})))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Outcome {
    Ready,
    Missing,
    Failed,
}

/// The expander of the tests: a `{"$blobRef": digest}` at `/value` waits for the test to say how the read ends.
#[derive(Default)]
struct Prep {
    gates: Mutex<HashMap<String, Arc<watch::Sender<Option<Outcome>>>>>,
}

impl Prep {
    fn gate(&self, digest: &str) -> Arc<watch::Sender<Option<Outcome>>> {
        Arc::clone(self.gates.lock().unwrap().entry(digest.to_owned()).or_insert_with(|| Arc::new(watch::channel(None).0)))
    }

    fn finish(&self, digest: &str, outcome: Outcome) {
        self.gate(digest).send_replace(Some(outcome));
    }
}

#[async_trait]
impl ParamRefs for Prep {
    async fn expand(&self, _method: &str, params: &mut Value, cancel: &CancellationToken) -> Result<(), CoreError> {
        let Some(digest) = params.pointer("/value/$blobRef").and_then(Value::as_str).map(str::to_owned) else {
            return Ok(());
        };
        let mut open = self.gate(&digest).subscribe();
        let outcome = tokio::select! {
            _ = cancel.cancelled() => return Err(CoreError::ConnectionClosed),
            outcome = async { (*open.wait_for(|outcome| outcome.is_some()).await.expect("gate open")).expect("set") } => outcome,
        };
        match outcome {
            Outcome::Ready => {
                params["value"] = json!({ "sessionId": "s", "reveal": true, "tab": digest });
                Ok(())
            }
            Outcome::Missing => Err(CoreError::InvalidParams { path: "/value/$blobRef".into(), expected: "a stored blob".into() }),
            Outcome::Failed => Err(CoreError::DomainError { domain: "blob".into(), code: None, message: Some("read failed".into()), detail: None }),
        }
    }
}

struct Harness {
    rig: Rig,
    recorder: Arc<Recorder>,
    prep: Arc<Prep>,
}

fn harness() -> Harness {
    let rig = Rig::new();
    let recorder = Arc::new(Recorder::default());
    rig.core.serve(recorder.clone());
    let prep = Arc::new(Prep::default());
    rig.server.inject_param_refs(prep.clone());
    Harness { rig, recorder, prep }
}

impl Harness {
    /// A connection that declared the visualize role and claimed it as `host`.
    async fn claimed(&self, id: u64, host: &str) -> Client {
        let client = self.rig.ready(id, json!({ "host": { "visualize": true } }));
        client.request(1, "host/claim", json!({ "hostId": host }));
        assert_eq!(client.response(1).await["result"], json!({}));
        client
    }

    async fn applied(&self) -> Vec<Applied> {
        for _ in 0..5 {
            settle().await;
        }
        self.recorder.log.lock().unwrap().clone()
    }

    async fn tags(&self) -> Vec<String> {
        self.applied().await.into_iter().map(|applied| applied.tag).collect()
    }

    fn pending(&self, id: u64) -> usize {
        self.rig.outgoing.connection(ConnectionId(id)).expect("connection open").state_order.pending()
    }
}

fn inline(client: &Client, id: i64, tag: &str) {
    client.request(id, "host/state/set", json!({ "key": "visualize", "value": { "sessionId": "s", "reveal": true, "tab": tag } }));
}

fn blob(client: &Client, id: i64, digest: &str) {
    client.request(id, "host/state/set", json!({ "key": "visualize", "value": { "$blobRef": digest, "as": "text" } }));
}

fn on_thread(client: &Client, id: i64, thread: &str, tag: &str) {
    client.request(id, "host/state/set", json!({ "key": "visualize", "threadId": thread, "value": { "sessionId": "s", "reveal": true, "tab": tag } }));
}

fn tags(of: &[&str]) -> Vec<String> {
    of.iter().map(|tag| (*tag).to_owned()).collect()
}

#[tokio::test(start_paused = true)]
async fn a_delayed_publication_is_applied_before_the_ready_one_after_it_even_when_it_finishes_after_a_local_timeout() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    blob(&a, 10, "A1");
    inline(&a, 11, "A2");
    assert!(h.applied().await.is_empty(), "A2 is ready but A1 came first");
    tokio::time::advance(Duration::from_secs(120)).await; // the sender's timeout passed; the request is still pending here
    h.prep.finish("A1", Outcome::Ready);
    assert_eq!(h.tags().await, tags(&["A1", "A2"]), "the final state is A2");
    assert!(h.applied().await.iter().all(|applied| applied.current));
}

#[tokio::test(start_paused = true)]
async fn an_inline_publication_goes_at_once_and_a_blob_one_holds_the_inline_ones_behind_it() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    inline(&a, 10, "A1");
    blob(&a, 11, "A2");
    inline(&a, 12, "A3");
    assert_eq!(h.tags().await, tags(&["A1"]));
    h.prep.finish("A2", Outcome::Ready);
    assert_eq!(h.tags().await, tags(&["A1", "A2", "A3"]));
}

#[tokio::test(start_paused = true)]
async fn a_claim_snapshot_whose_blob_is_slow_is_followed_by_the_events_sent_after_it() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    blob(&a, 10, "snapshot");
    inline(&a, 11, "E1");
    inline(&a, 12, "E2");
    h.prep.finish("snapshot", Outcome::Ready);
    assert_eq!(h.tags().await, tags(&["snapshot", "E1", "E2"]));
}

#[tokio::test(start_paused = true)]
async fn publications_with_different_raw_thread_ids_keep_socket_order() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    on_thread(&a, 10, "x", "E0");
    on_thread(&a, 11, "x", "E1");
    on_thread(&a, 12, "y", "E2");
    on_thread(&a, 13, "x", "E3");
    on_thread(&a, 14, "y", "E4");
    assert_eq!(h.tags().await, tags(&["E0", "E1", "E2", "E3", "E4"]));
    // And with the first one waiting for its blob while the lanes start the others round-robin.
    let b = h.claimed(2, "b").await;
    blob(&b, 10, "B0");
    on_thread(&b, 11, "x", "B1");
    on_thread(&b, 12, "y", "B2");
    assert_eq!(h.tags().await.len(), 5, "nothing of B before B0");
    h.prep.finish("B0", Outcome::Ready);
    assert_eq!(h.tags().await[5..], tags(&["B0", "B1", "B2"])[..]);
}

#[tokio::test(start_paused = true)]
async fn a_missing_blob_and_a_failed_read_each_release_the_publications_after_them() {
    for (digest, outcome) in [("missing", Outcome::Missing), ("broken", Outcome::Failed)] {
        let h = harness();
        let a = h.claimed(1, "a").await;
        blob(&a, 10, digest);
        inline(&a, 11, "after");
        assert!(h.applied().await.is_empty());
        h.prep.finish(digest, outcome);
        assert_eq!(h.tags().await, tags(&["after"]), "{digest}");
        let refused = a.response(10).await;
        assert!(refused.get("error").is_some(), "{digest}: {refused}");
        assert_eq!(h.pending(1), 0, "{digest}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_closing_connection_gives_every_place_up() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    blob(&a, 10, "never");
    inline(&a, 11, "later");
    assert_eq!(h.pending(1), 2);
    let conn = h.rig.outgoing.connection(ConnectionId(1)).unwrap();
    drop(a);
    for _ in 0..5 {
        settle().await;
    }
    assert_eq!(conn.state_order.pending(), 0, "nothing waits for a blob that will never be read");
    assert!(h.applied().await.is_empty(), "the closed connection's publications are not applied");
}

#[tokio::test(start_paused = true)]
async fn a_waiting_publication_blocks_neither_another_connection_nor_another_host_state_key() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    let b = h.claimed(2, "b").await;
    blob(&a, 10, "A1");
    a.request(11, "host/state/set", json!({ "key": "browserTabs", "value": [] }));
    inline(&b, 10, "B1");
    let seen = h.applied().await;
    let mut seen: Vec<(u64, &str)> = seen.iter().map(|applied| (applied.conn, applied.key.as_str())).collect();
    seen.sort_unstable(); // the two connections' order against each other is not defined
    assert_eq!(seen, [(1, "browserTabs"), (2, "visualize")]);
    h.prep.finish("A1", Outcome::Ready);
    assert_eq!(h.applied().await.last().map(|applied| applied.tag.clone()), Some("A1".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn only_the_current_claimant_is_current_when_it_is_applied_through_claims_fallback_and_replacement() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    let b = h.claimed(2, "b").await;
    inline(&a, 10, "A-while-b-holds");
    h.applied().await;
    inline(&b, 10, "B1");
    h.applied().await;
    // A's publication that waits for its blob while B holds the role, and B's after it.
    blob(&a, 11, "A-late");
    inline(&b, 11, "B2");
    h.applied().await;
    drop(b); // the claim falls back to A
    h.prep.finish("A-late", Outcome::Ready);
    h.applied().await;
    inline(&a, 12, "A-after-fallback");
    let seen: Vec<(String, bool)> = h.applied().await.into_iter().map(|applied| (applied.tag, applied.current)).collect();
    assert_eq!(
        seen,
        [("A-while-b-holds", false), ("B1", true), ("B2", true), ("A-late", true), ("A-after-fallback", true)].map(|(tag, current)| (tag.to_owned(), current))
    );
}
#[tokio::test(start_paused = true)]
async fn a_same_host_replacement_displaces_the_live_old_connection_and_its_close_leaves_no_claimant() {
    let h = harness();
    let old = h.claimed(1, "pc").await;
    let new = h.claimed(2, "pc").await;
    inline(&old, 10, "old");
    h.applied().await;
    inline(&new, 10, "new");
    h.applied().await;
    drop(new);
    inline(&old, 11, "old-after");
    let seen: Vec<(String, bool)> = h.applied().await.into_iter().map(|applied| (applied.tag, applied.current)).collect();
    assert_eq!(seen, [("old", false), ("new", true), ("old-after", false)].map(|(tag, current)| (tag.to_owned(), current)));
}

#[tokio::test(start_paused = true)]
async fn a_publication_the_lanes_refuse_gives_its_place_up() {
    let h = harness();
    let a = h.claimed(1, "a").await;
    // 520 queue under one owner, a second owner competes, and the first owner's next one is over its fair share.
    for n in 0..520 {
        on_thread(&a, 100 + n, "x", &format!("x{n}"));
    }
    on_thread(&a, 700, "y", "y");
    on_thread(&a, 701, "x", "refused");
    let refused = a.response(701).await;
    assert!(refused.get("error").is_some(), "{refused}");
    let mut seen = Vec::new();
    for _ in 0..400 {
        settle().await;
        seen = h.tags().await;
        if seen.len() == 521 {
            break;
        }
    }
    let mut expected: Vec<String> = (0..520).map(|n| format!("x{n}")).collect();
    expected.push("y".to_owned());
    assert_eq!(seen, expected, "socket order, the refused one absent");
    assert_eq!(h.pending(1), 0);
}
