//! The `terminal` tool's reveal: after a command is entered, ask the attached UIs to show the
//! terminal (`ui/openRequested { kind: "terminal", requestId }`) and wait for a pane to claim it
//! (`ui/terminalRun/claimed`). The result is `shown`: true on a claim, false when no UI is
//! attached to take the request or nobody claims it in time (the terminal keeps running).
//! A paired phone is told the same reveal without its ack id and without any path (a tab's working
//! directory is a PC path; the phone adopts the tab and binds its own root).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_spawn::terminal::SessionTab;
use mixdog_spawn::terminal::TerminalBridgeHost;
use serde_json::Value;
use serde_json::json;
use uuid::Uuid;

use super::pending::PendingWaits;

/// The core's `ui/openRequested` feed.
pub trait OpenFeed: Send + Sync {
    /// Publishes the event to the attached UIs; false when none is attached to take it.
    fn publish_open(&self, params: Value) -> bool;
}

/// Where a terminal reveal goes: the desktop gets the whole request (the ack id and each tab's
/// directory), a paired phone the projection that carries neither.
pub trait RevealFeed: Send + Sync {
    /// Delivers `full` to the windows and the other clients, `relay` to the paired phones. False
    /// when no desktop window took it.
    fn publish_reveal(&self, full: Value, relay: Value) -> bool;
}

/// What a paired phone is told of a terminal reveal (`remoteTerminalRun`): the session, the
/// terminal and the tabs by id and number, with no `requestId` and no `cwd`.
pub fn relay_projection(request: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in ["kind", "sessionId"] {
        if let Some(v) = request.get(key) {
            out.insert(key.to_owned(), v.clone());
        }
    }
    if let Some(id) = request.get("terminalId").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
        out.insert("terminalId".to_owned(), id.clone());
    }
    if let Some(tabs) = request.get("tabs").and_then(Value::as_array) {
        let tabs = tabs.iter().map(|t| json!({ "id": t.get("id"), "tab": t.get("tab") })).collect::<Vec<_>>();
        out.insert("tabs".to_owned(), Value::Array(tabs));
    }
    Value::Object(out)
}

/// What only the host knows besides the reveal: the thread's working directory.
#[async_trait]
pub trait SessionCwds: Send + Sync {
    async fn session_cwd(&self, session_id: &str) -> Option<String>;
}

pub struct RevealingTerminalHost {
    cwds: Arc<dyn SessionCwds>,
    feed: Arc<dyn RevealFeed>,
    waits: PendingWaits,
}

impl RevealingTerminalHost {
    pub fn new(cwds: Arc<dyn SessionCwds>, feed: Arc<dyn RevealFeed>, waits: PendingWaits) -> Self {
        Self { cwds, feed, waits }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use super::*;

    struct Cwds;
    #[async_trait]
    impl SessionCwds for Cwds {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            Some("/w".to_owned())
        }
    }

    /// A feed that records what it was given and, when `claim` is set, claims it like a pane.
    struct Feed {
        attached: bool,
        claim: bool,
        waits: PendingWaits,
        seen: Mutex<Vec<Value>>,
        relayed: Mutex<Vec<Value>>,
    }
    impl RevealFeed for Feed {
        fn publish_reveal(&self, params: Value, relay: Value) -> bool {
            self.relayed.lock().unwrap().push(relay);
            if self.claim {
                let id = params["requestId"].as_str().unwrap().to_owned();
                let waits = self.waits.clone();
                tokio::spawn(async move {
                    waits.claim_terminal_run(&id);
                    // A pane that reports twice settles nothing more.
                    assert!(!waits.claim_terminal_run(&id));
                });
            }
            self.seen.lock().unwrap().push(params);
            self.attached
        }
    }

    fn tab(n: u32) -> SessionTab {
        SessionTab { tab: n, id: format!("session-terminal:s{n}"), shell: "sh".into(), running: true, cwd: Some("/w".into()) }
    }

    #[test]
    fn the_projection_leaves_out_an_empty_terminal_id_and_tolerates_no_tabs() {
        let p = relay_projection(&json!({ "kind": "terminal", "sessionId": "s1", "terminalId": "", "requestId": "r", "cwd": "/x" }));
        assert_eq!(p, json!({ "kind": "terminal", "sessionId": "s1" }));
    }

    async fn reveal(attached: bool, claim: bool, terminal_ms: u64) -> (bool, Vec<Value>) {
        let (shown, seen, _) = reveal_all(attached, claim, terminal_ms).await;
        (shown, seen)
    }
    async fn reveal_all(attached: bool, claim: bool, terminal_ms: u64) -> (bool, Vec<Value>, Vec<Value>) {
        let waits = crate::desktop::pending::tests::waits(3000, terminal_ms);
        let feed = Arc::new(Feed { attached, claim, waits: waits.clone(), seen: Mutex::default(), relayed: Mutex::default() });
        let host = RevealingTerminalHost::new(Arc::new(Cwds), feed.clone(), waits);
        let shown = host.reveal("s1", &tab(1), &[tab(1), tab(2)]).await;
        let seen = feed.seen.lock().unwrap().clone();
        let relayed = feed.relayed.lock().unwrap().clone();
        (shown, seen, relayed)
    }
    #[tokio::test]
    async fn a_claim_shows_the_terminal_and_the_request_names_it() {
        let (shown, seen) = reveal(true, true, 5000).await;
        assert!(shown);
        let request = &seen[0];
        assert_eq!(request["kind"], "terminal");
        assert_eq!(request["sessionId"], "s1");
        assert_eq!(request["terminalId"], "session-terminal:s1");
        assert_eq!(request["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(request["tabs"][1], json!({"id": "session-terminal:s2", "tab": 2, "cwd": "/w"}));
        assert!(Uuid::parse_str(request["requestId"].as_str().unwrap()).is_ok());
    }
    #[tokio::test]
    async fn no_attached_ui_settles_not_shown_at_once() {
        let started = std::time::Instant::now();
        let (shown, _) = reveal(false, false, 5000).await;
        assert!(!shown);
        assert!(started.elapsed() < Duration::from_millis(1000));
    }
    #[tokio::test]
    async fn an_unclaimed_request_settles_not_shown_at_the_deadline() {
        let (shown, seen) = reveal(true, false, 40).await;
        assert!(!shown);
        assert_eq!(seen.len(), 1);
    }
    #[tokio::test]
    async fn a_phone_is_told_the_reveal_without_any_path_or_ack_id_while_the_desktop_keeps_the_full_request() {
        let (_, seen, relayed) = reveal_all(true, true, 5000).await;
        assert!(seen[0]["requestId"].is_string());
        assert_eq!(seen[0]["tabs"][1]["cwd"], "/w", "the desktop still adopts each tab's root");
        assert_eq!(
            relayed,
            vec![json!({
                "kind": "terminal",
                "sessionId": "s1",
                "terminalId": "session-terminal:s1",
                "tabs": [{"id": "session-terminal:s1", "tab": 1}, {"id": "session-terminal:s2", "tab": 2}],
            })]
        );
        let text = relayed[0].to_string();
        assert!(!text.contains("requestId") && !text.contains("cwd") && !text.contains("/w"));
    }
}

#[async_trait]
impl TerminalBridgeHost for RevealingTerminalHost {
    async fn session_cwd(&self, session_id: &str) -> Option<String> {
        self.cwds.session_cwd(session_id).await
    }

    async fn reveal(&self, session_id: &str, target: &SessionTab, tabs: &[SessionTab]) -> bool {
        let request_id = Uuid::new_v4().to_string();
        let mut wait = self.waits.watch_terminal_run(session_id, &request_id);
        let request = json!({
            "kind": "terminal",
            "sessionId": session_id,
            "terminalId": target.id,
            "tabs": tabs.iter().map(|t| json!({"id": t.id, "tab": t.tab, "cwd": t.cwd})).collect::<Vec<_>>(),
            "requestId": request_id,
        });
        let relay = relay_projection(&request);
        if !self.feed.publish_reveal(request, relay) {
            return false;
        }
        wait.wait().await.is_some()
    }
}
