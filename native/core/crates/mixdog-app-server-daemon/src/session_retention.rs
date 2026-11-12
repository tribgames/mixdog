//! The sub-agent retention cycle in the daemon (Node `session/manager/idle-cleanup.mjs`
//! `_retainSubAgents`, run by the 5-minute cycle `startIdleCleanup` starts with the session
//! runtime, `runtime-bootstrap.mjs:97`): finished sub-agent trees are archived after three idle
//! days and deleted after thirty (`mixdog_core_session::session::sub_agent_retention`).
//!
//! Node's timer is only unref'd; the Rust cycle is a task that ends with its token, and the stop
//! procedure cancels it and awaits it before the session directory shuts down, so no pass is
//! reading or deleting sessions while the directory closes.

use std::sync::Arc;

use mixdog_core_session::session::sub_agent_retention::RetentionHost;
use mixdog_core_session::session::sub_agent_retention::start as start_cycle;
use tokio_util::sync::CancellationToken;

/// The running cycle.
pub struct Running {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

/// Starts the cycle over `host`, judging idleness by `now` (epoch ms). A failed pass is written
/// as Node writes it: `[session-sweep] sub-agent retention error: <message>`.
pub fn start(host: Arc<dyn RetentionHost>, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Running {
    let stop = CancellationToken::new();
    let on_error: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|line| mixdog_rt::node_stderr!("[session-sweep] {line}"));
    Running { task: start_cycle(host, now, on_error, stop.clone()), stop }
}

impl Running {
    /// No pass is admitted from here; returns once the pass under way has finished what it admitted.
    pub async fn end(self) {
        self.stop.cancel();
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use mixdog_core_api::CoreError;
    use mixdog_core_session::session::sub_agent_retention::SWEEP_INTERVAL;
    use mixdog_store::schema::record::Header;
    use serde_json::json;

    use super::*;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);
    const BASE_MS: f64 = 1_800_000_000_000.0;

    /// Sessions by id with their stored headers; what the cycle archived and deleted. A delete
    /// removes the session, an archive marks it, as the store does.
    struct Store {
        headers: Mutex<HashMap<String, Header>>,
        live: HashSet<String>,
        archived: Mutex<Vec<String>>,
        deleted: Mutex<Vec<String>>,
    }

    fn child(id: &str, parent: &str, active: f64) -> (String, Header) {
        let header = json!({"agent": "worker", "owner": "lead", "ownerSessionId": parent, "parentSessionId": parent, "visibility": "agent-only", "lastUsedAt": active});
        (id.to_owned(), header.as_object().unwrap().clone())
    }

    #[async_trait]
    impl RetentionHost for Store {
        async fn agent_only_ids(&self) -> Result<Vec<String>, CoreError> {
            let mut ids: Vec<String> = self.headers.lock().unwrap().keys().cloned().collect();
            ids.sort();
            Ok(ids)
        }
        async fn stored_header(&self, id: &str) -> Result<Option<Header>, CoreError> {
            Ok(self.headers.lock().unwrap().get(id).cloned())
        }
        fn is_live(&self, id: &str) -> bool {
            self.live.contains(id)
        }
        async fn archive(&self, id: &str) -> Result<(), CoreError> {
            self.headers.lock().unwrap().get_mut(id).unwrap().insert("archivedAt".into(), json!(1));
            self.archived.lock().unwrap().push(id.to_owned());
            Ok(())
        }
        async fn delete(&self, id: &str, _: f64, _: &[(String, f64)], _: &mixdog_rt::CancellationToken) -> Result<bool, CoreError> {
            self.headers.lock().unwrap().remove(id);
            self.deleted.lock().unwrap().push(id.to_owned());
            Ok(true)
        }
    }

    /// The wall clock the cycle reads, moved by the paused runtime: `BASE_MS` at the start.
    fn paused_clock() -> Arc<dyn Fn() -> f64 + Send + Sync> {
        let began = tokio::time::Instant::now();
        Arc::new(move || BASE_MS + began.elapsed().as_millis() as f64)
    }

    /// An idle tree (a top sub-agent and the one below it) is archived once idle three days and
    /// deleted once idle thirty; a tree with a member open here, and one used recently, stay.
    #[tokio::test(start_paused = true)]
    async fn an_idle_tree_is_archived_after_three_days_and_deleted_after_thirty_but_a_live_or_recent_one_stays() {
        mixdog_rt::testing::tokens();
        let idle_since = BASE_MS;
        let headers = [
            child("sess_idle_top", "sess_lead", idle_since),
            child("sess_idle_leaf", "sess_idle_top", idle_since),
            child("sess_live", "sess_lead", idle_since),
            // Used on day 29: under three days idle at the 30-day mark.
            child("sess_recent", "sess_lead", idle_since + 29.0 * 86_400_000.0),
        ];
        let store = Arc::new(Store {
            headers: Mutex::new(headers.into_iter().collect()),
            live: HashSet::from(["sess_live".to_owned()]),
            archived: Mutex::default(),
            deleted: Mutex::default(),
        });
        let running = start(store.clone(), paused_clock());

        mixdog_rt::time::sleep(3 * DAY - SWEEP_INTERVAL).await;
        assert!(store.archived.lock().unwrap().is_empty(), "idle less than three days");
        mixdog_rt::time::sleep(2 * SWEEP_INTERVAL).await;
        let mut archived = store.archived.lock().unwrap().clone();
        archived.sort();
        assert_eq!(archived, ["sess_idle_leaf", "sess_idle_top"], "the whole idle tree, nothing live or recent");
        assert!(store.deleted.lock().unwrap().is_empty());

        // Day 29 and a half: the idle tree is not yet idle thirty days.
        mixdog_rt::time::sleep(26 * DAY + DAY / 2).await;
        assert!(store.deleted.lock().unwrap().is_empty(), "idle less than thirty days");
        mixdog_rt::time::sleep(DAY).await;
        let mut deleted = store.deleted.lock().unwrap().clone();
        deleted.sort();
        assert_eq!(deleted, ["sess_idle_leaf", "sess_idle_top"]);
        let kept: HashSet<String> = store.headers.lock().unwrap().keys().cloned().collect();
        assert_eq!(kept, HashSet::from(["sess_live".to_owned(), "sess_recent".to_owned()]));
        assert!(store.archived.lock().unwrap().iter().all(|id| id.starts_with("sess_idle")), "the live and the recent tree were never archived");

        running.end().await;
    }

    /// Ending the cycle admits no pass after it: nothing is archived by a pass that would have fallen due.
    #[tokio::test(start_paused = true)]
    async fn an_ended_cycle_sweeps_no_more() {
        mixdog_rt::testing::tokens();
        let store = Arc::new(Store {
            headers: Mutex::new([child("sess_a", "sess_lead", BASE_MS)].into_iter().collect()),
            live: HashSet::new(),
            archived: Mutex::default(),
            deleted: Mutex::default(),
        });
        let running = start(store.clone(), paused_clock());
        running.end().await;
        mixdog_rt::time::sleep(4 * DAY).await;
        assert!(store.archived.lock().unwrap().is_empty());
    }
}
