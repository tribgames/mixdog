//! The `terminal` tool's reveal: after a command is entered, ask the attached UIs to show the
//! terminal (`ui/openRequested { kind: "terminal", requestId }`) and wait for a pane to claim it
//! (`ui/terminalRun/claimed`). The result is `shown`: true on a claim, false when no UI is
//! attached to take the request or nobody claims it in time (the terminal keeps running).

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

/// What only the host knows besides the reveal: the thread's working directory.
#[async_trait]
pub trait SessionCwds: Send + Sync {
    async fn session_cwd(&self, session_id: &str) -> Option<String>;
}

pub struct RevealingTerminalHost {
    cwds: Arc<dyn SessionCwds>,
    feed: Arc<dyn OpenFeed>,
    waits: PendingWaits,
}

impl RevealingTerminalHost {
    pub fn new(cwds: Arc<dyn SessionCwds>, feed: Arc<dyn OpenFeed>, waits: PendingWaits) -> Self {
        Self { cwds, feed, waits }
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
        if !self.feed.publish_open(request) {
            return false;
        }
        wait.wait().await.is_some()
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
    }
    impl OpenFeed for Feed {
        fn publish_open(&self, params: Value) -> bool {
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

    async fn reveal(attached: bool, claim: bool, terminal_ms: u64) -> (bool, Vec<Value>) {
        let waits = crate::desktop::pending::tests::waits(3000, terminal_ms);
        let feed = Arc::new(Feed { attached, claim, waits: waits.clone(), seen: Mutex::default() });
        let host = RevealingTerminalHost::new(Arc::new(Cwds), feed.clone(), waits);
        let shown = host.reveal("s1", &tab(1), &[tab(1), tab(2)]).await;
        let seen = feed.seen.lock().unwrap().clone();
        (shown, seen)
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
}
