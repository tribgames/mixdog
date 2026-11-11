//! The registry calls the spawn and send worlds make (`SpawnWorld`/`SendWorld` of the agent
//! tool): the session as the manager holds it, the next auto tag, and the tag bind with its row
//! write. They are `mgr.getSession`, `nextTag` (`tag-registry/tag-lookup.mjs:101`),
//! `bindTag` (`tag-registry.mjs:98`) and `upsertWorkerSessionDeferred`, over the state the
//! registry already keeps.

use std::sync::Arc;

use mixdog_agent::agent_tool::host::ResolveOptions;
use mixdog_agent::agent_tool::scope::Scope;

use super::{AgentRegistry, Row, clean};

/// The release of `beginCancellation`: dropping it ends the cancellations it began (the epochs
/// stay moved).
pub struct CancelScope {
    registry: std::sync::Arc<AgentRegistry>,
    ids: Vec<String>,
}

impl Drop for CancelScope {
    fn drop(&mut self) {
        let mut st = self.registry.lock();
        for id in &self.ids {
            let remaining = st.cancelling.get(id).copied().unwrap_or(0).saturating_sub(1);
            if remaining > 0 {
                st.cancelling.insert(id.clone(), remaining);
            } else {
                st.cancelling.remove(id);
            }
        }
    }
}

impl AgentRegistry {
    /// `mgr.getSession(id)`: the loaded session's header, else its stored list row.
    pub fn session_row(&self, id: &str) -> Option<Row> {
        self.session_of(id)
    }

    /// `nextTag(agent, context)`: the agent plus a per-agent local index with no hyphen
    /// (`worker3`, `heavy-worker7`, `agent1` when the agent is unset). The index is the highest
    /// existing `^agent(\d+)$` plus one, and keeps counting past any live collision.
    pub fn next_tag(&self, agent: &str, scope: &Scope) -> String {
        let mut st = self.lock();
        self.refresh(&mut st, false, scope);
        let base = match mixdog_js::js_trim(agent) {
            "" => "agent",
            base => base,
        };
        let mut highest = 0.0_f64;
        for (existing, _) in st.tags.iter() {
            let Some(digits) = existing.strip_prefix(base).filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) else {
                continue;
            };
            if let Ok(n) = digits.parse::<f64>()
                && n.is_finite()
                && n > highest
            {
                highest = n;
            }
        }
        let mut n = highest + 1.0;
        loop {
            let tag = format!("{base}{n}");
            let taken = self.resolve(&mut st, &tag, scope, ResolveOptions { scan_sessions: false, exclude_terminal_traces: false });
            if !matches!(taken, Ok(Some(_))) {
                return tag;
            }
            n += 1.0;
        }
    }

    /// `bindTag(tag, session, extra)`: the tag joins the maps and the session's worker row is
    /// written with `extra`. Nothing without a tag or a session id.
    pub fn bind_tag_row(&self, tag: &str, session: &Row, extra: &Row) {
        let id = clean(session.get("id"));
        if tag.is_empty() || id.is_empty() {
            return;
        }
        let mut st = self.lock();
        st.bind(tag, &id, &clean(session.get("agent")), &clean(session.get("cwd")));
        self.upsert_session(&mut st, session, tag, extra);
    }

    /// `purgeWorkerRows(ownerSessionId, closedSessionIds)` (`close-flow/close-all.mjs:22-37`): the
    /// rows of `owner`'s workers, and of the sessions just closed, go; a Lead's pool row and a
    /// row whose owner is still owed its restart failure stay.
    pub fn purge_owner_rows(&self, owner: &str, closed: &std::collections::HashSet<String>) {
        let mut st = self.lock();
        let now = self.now();
        let doomed: Vec<String> = st
            .maps
            .iter()
            .filter_map(|(id, map)| st.row(id, map, now))
            .filter(|row| !super::is_lead_pool_agent(row.get("agent")) && !super::restart::is_unnotified_restart_failure(row))
            .filter(|row| clean(row.get("ownerSessionId")) == owner || closed.contains(&clean(row.get("sessionId"))))
            .map(|row| clean(row.get("sessionId")))
            .collect();
        for id in doomed {
            self.remove_row(&mut st, &id);
        }
    }

    /// `registry.childrenOf(parent)`: the agent sessions linked directly below `parent` (by their
    /// `parentSessionId || ownerSessionId`).
    pub fn children_of(&self, parent: &str) -> Vec<String> {
        let st = self.lock();
        self.list_sessions(&st, true)
            .into_iter()
            .filter(|s| {
                let link = super::either(s, "parentSessionId", "ownerSessionId");
                clean(link) == parent && clean(s.get("id")) != parent
            })
            .map(|s| clean(s.get("id")))
            .filter(|id| !id.is_empty())
            .collect()
    }

    /// `registry.assertAdmission(id, epoch)` (`agent-tree/agent-registry.mjs:59`): refused while a
    /// cancellation covers the session, or when one has covered it since `epoch` was read
    /// (`None`: the epoch now). The epoch to compare against later.
    pub fn assert_admission(&self, id: &str, epoch: Option<u64>) -> Result<u64, String> {
        let st = self.lock();
        let now = st.epochs.get(id).copied().unwrap_or(0);
        if st.cancelling.contains_key(id) || now != epoch.unwrap_or(now) {
            return Err(format!("agent session {id} was cancelled during admission"));
        }
        Ok(now)
    }

    /// `registry.beginCancellation(ids)`: every session of the tree being cancelled is refused
    /// admission until the guard drops, and each one's epoch moves for good.
    pub fn begin_cancellation(self: &Arc<Self>, ids: &[String]) -> CancelScope {
        let mut st = self.lock();
        for id in ids {
            *st.cancelling.entry(id.clone()).or_insert(0) += 1;
            *st.epochs.entry(id.clone()).or_insert(0) += 1;
        }
        CancelScope { registry: self.clone(), ids: ids.to_vec() }
    }

    /// `upsertWorkerSessionDeferred(session, tag, extra)`.
    pub fn upsert_worker_row(&self, session: &Row, tag: &str, extra: &Row) {
        self.upsert_session_row(session, tag, extra);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde_json::json;

    use super::super::{Clock, LiveSessions, ReapWindow, WorkerStore};
    use super::*;
    use serde_json::Value;

    struct Empty;

    #[async_trait]
    impl WorkerStore for Empty {
        async fn worker_maps(&self) -> Result<Vec<(String, Row)>, String> {
            Ok(Vec::new())
        }
        async fn agent_sessions(&self) -> Result<Vec<Row>, String> {
            Ok(Vec::new())
        }
        async fn header(&self, _: &str) -> Option<Row> {
            None
        }
        async fn is_directory(&self, _: &str) -> bool {
            false
        }
        fn write(&self, _: &str, _: Option<Row>) {}
    }

    impl LiveSessions for Empty {
        fn loaded(&self) -> Vec<String> {
            Vec::new()
        }
        fn header(&self, _: &str) -> Option<Row> {
            None
        }
        fn running(&self, _: &str) -> bool {
            false
        }
        fn has_live_work(&self, _: &str) -> bool {
            false
        }
        fn runtime_stage(&self, _: &str) -> Option<String> {
            None
        }
    }

    impl ReapWindow for Empty {
        fn terminal_reap_ms(&self, _: &str) -> f64 {
            3_600_000.0
        }
    }

    impl Clock for Empty {
        fn now_ms(&self) -> i64 {
            1_793_923_200_000
        }
    }

    fn registry() -> AgentRegistry {
        let empty = Arc::new(Empty);
        AgentRegistry::new(empty.clone(), empty.clone(), empty.clone(), empty)
    }

    fn row(value: Value) -> Row {
        value.as_object().cloned().unwrap_or_default()
    }

    /// `assertAdmission` / `beginCancellation`: refused while covered and after any cancellation
    /// since the epoch was read.
    #[test]
    fn a_cancellation_refuses_admission_while_it_runs_and_moves_the_epoch_for_good() {
        let registry = Arc::new(registry());
        let epoch = registry.assert_admission("p", None).unwrap();
        assert_eq!(epoch, 0);
        let scope = registry.begin_cancellation(&["p".to_owned(), "c".to_owned()]);
        assert_eq!(registry.assert_admission("p", None).unwrap_err(), "agent session p was cancelled during admission");
        assert!(registry.assert_admission("c", None).is_err());
        drop(scope);
        assert_eq!(registry.assert_admission("p", None), Ok(1), "admitted again, at the moved epoch");
        assert!(registry.assert_admission("p", Some(epoch)).is_err(), "a spawn that began before the cancel is refused");
        let first = registry.begin_cancellation(&["p".to_owned()]);
        let second = registry.begin_cancellation(&["p".to_owned()]);
        drop(first);
        assert!(registry.assert_admission("p", None).is_err(), "still covered by the second");
        drop(second);
        assert!(registry.assert_admission("p", None).is_ok());
    }

    /// `nextTag`: agent plus the highest own index plus one, matched literally for a hyphenated
    /// agent; an unset agent counts as `agent`.
    #[test]
    fn the_next_tag_follows_the_highest_index_of_the_agent() {
        let registry = registry();
        let scope = Scope::default();
        assert_eq!(registry.next_tag("worker", &scope), "worker1");
        for (tag, id) in [("worker1", "s1"), ("worker7", "s2"), ("heavy-worker2", "s3"), ("worker-x", "s4")] {
            registry.bind_tag_row(tag, &row(json!({ "id": id, "agent": "worker", "cwd": "/w" })), &Row::new());
        }
        assert_eq!(registry.next_tag("worker", &scope), "worker8");
        assert_eq!(registry.next_tag("heavy-worker", &scope), "heavy-worker3");
        assert_eq!(registry.next_tag("  ", &scope), "agent1");
    }

    struct NoRelease;
    impl super::super::RuntimeRelease for NoRelease {
        fn release(&self, _: &mixdog_core_api::ids::ThreadId, _: &str) {}
    }

    /// `agent-turns.mjs:96`: a worker turn on a session a cancellation covers is refused before
    /// anything starts, with `assertAdmission`'s text.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_worker_turn_on_a_session_being_cancelled_is_refused() {
        use mixdog_agent::agent_tool::flow::seams::{TurnHooks, TurnKind, TurnRequest, TurnSessions};
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(crate::session::SessionDirectory::new(rig.deps()));
        let handle = crate::session::tests::start_thread(&directory).await;
        let registry = Arc::new(registry());
        let turns = super::super::SessionTurns::new(directory, Arc::new(NoRelease)).with_admission(registry.clone());
        let id = handle.id.as_str().to_owned();
        let _cancelling = registry.begin_cancellation(&[id.clone()]);
        let request = TurnRequest {
            kind: TurnKind::Spawn,
            session_id: id.clone(),
            prompt: "go".into(),
            attachments: Vec::new(),
            context: None,
            cwd: String::new(),
            skill_selection: None,
            hooks: TurnHooks {
                submission_id: String::new(),
                notify: Arc::new(|_, _| false),
                on_tool_result: Arc::new(|_| {}),
                on_terminal_result: None,
            },
            slot: None,
        };
        let error = turns.run_turn(request).await.unwrap_err();
        assert_eq!(error.message, format!("agent session {id} was cancelled during admission"));
    }
}