//! The real [`RunStamps`]: the `run` stamped on a stored session (`runStampOf`,
//! `human-gate/delegation.mjs:108`), with Node's backfill of records older than the stamp
//! (`stampRun`, `legacyRunOf`). A record is read where Node reads it (`loadRecord`): the live
//! header of a loaded thread, else the stored record on the io lane, for the session and for
//! every ancestor the backfill walks to.
//!
//! Node also keeps a backfilled run on the live record so its next save persists it; the
//! answer is the same without, because the backfill derives the same run every time.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::SessionDirectory;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_ports::ports::run_stamps::RunStamps;
use mixdog_core_config::workflow::ids::truthy;

/// `MAX_PATH`: how far up the parents a backfill walks.
const MAX_PATH: usize = 32;

/// Where a session's record is read (`loadRecord`).
#[async_trait]
pub trait Records: Send + Sync {
    async fn record(&self, session: &str) -> Option<Header>;
}

#[async_trait]
impl Records for SessionDirectory {
    async fn record(&self, session: &str) -> Option<Header> {
        self.stored_header(&ThreadId::from(session)).await
    }
}

pub struct DirectoryRunStamps {
    records: Arc<dyn Records>,
}

impl DirectoryRunStamps {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { records: directory }
    }
}

#[async_trait]
impl RunStamps for DirectoryRunStamps {
    async fn stamp_of(&self, thread: &ThreadId) -> Option<Value> {
        run_stamp_of(thread.as_str(), self.records.as_ref()).await
    }
}
/// `clean`: a string trimmed, anything else empty.
fn clean(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| mixdog_js::js_trim(text).to_owned()).unwrap_or_default()
}

fn agent_owned(record: &Header) -> bool {
    clean(record.get("owner")).to_lowercase() == "agent" || clean(record.get("visibility")).to_lowercase() == "agent-only"
}

/// The session that spawned `record`, or empty for a top-level session.
fn parent_of(record: &Header) -> String {
    if !agent_owned(record) {
        return String::new();
    }
    let parent = clean(record.get("parentSessionId"));
    if parent.is_empty() { clean(record.get("ownerSessionId")) } else { parent }
}

/// `runStamp(kind, agentId, name)`: an owner is required; anything but a webhook is a schedule.
fn run_stamp(kind: Option<&Value>, agent_id: Option<&Value>, name: Option<&Value>) -> Option<Value> {
    let agent_id = clean(agent_id);
    if agent_id.is_empty() {
        return None;
    }
    let kind = if kind.and_then(Value::as_str) == Some("webhook") { "webhook" } else { "schedule" };
    let name = name.filter(|name| truthy(Some(name))).map(mixdog_js::value_to_string).unwrap_or_default();
    Some(serde_json::json!({ "kind": kind, "agentId": agent_id, "name": name }))
}

/// `RUN_TASK_SOURCE`: `^agent:([A-Za-z0-9_-]+)@run$`.
fn task_source_bot(source: &str) -> Option<&str> {
    let bot = source.strip_prefix("agent:")?.strip_suffix("@run")?;
    (!bot.is_empty() && bot.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then_some(bot)
}

/// What the backfill of a record without a stamp comes to.
enum Backfill {
    /// The record's own answer.
    Run(Option<Value>),
    /// It recorded none: its parent's run is its run.
    Parent(String),
}

/// `legacyRunOf`: the run a record from before the stamp was started by, from what it recorded.
fn legacy_run_of(id: &str, record: &Header, depth: usize) -> Backfill {
    let old = record.get("delegation");
    if let Some(old) = old.and_then(Value::as_object)
        && old.get("via").and_then(Value::as_str) == Some("run")
        && let Some(run) = old.get("run").and_then(Value::as_object)
    {
        let owner = match old.get("rootAgentId").filter(|owner| truthy(Some(owner))) {
            Some(owner) => Some(owner.clone()),
            None => old
                .get("rootSessionId")
                .and_then(Value::as_str)
                .and_then(agent_id_of_home_session)
                .map(Value::String),
        };
        return Backfill::Run(run_stamp(run.get("kind"), owner.as_ref(), run.get("name")));
    }
    if !agent_owned(record) && clean(record.get("sourceType")) == "lead" {
        if let Some(bot) = task_source_bot(&clean(record.get("sourceName"))) {
            return Backfill::Run(run_stamp(Some(&Value::from("schedule")), Some(&Value::from(bot)), None));
        }
    }
    let parent = parent_of(record);
    if parent.is_empty() || parent == id || old.is_some_and(Value::is_object) || depth >= MAX_PATH {
        return Backfill::Run(None);
    }
    Backfill::Parent(parent)
}

/// `runStampOf(sessionId)`: the record's stamp (`null` = attended), else the run it recorded
/// before stamps existed, else its parent's, up the chain; a record that is not there has none.
pub async fn run_stamp_of(session: &str, records: &dyn Records) -> Option<Value> {
    let mut id = mixdog_js::js_trim(session).to_owned();
    let mut depth = 0;
    loop {
        if id.is_empty() {
            return None;
        }
        let record = records.record(&id).await?;
        if let Some(run) = record.get("run") {
            return run.is_object().then(|| run.clone());
        }
        match legacy_run_of(&id, &record, depth) {
            Backfill::Run(run) => return run,
            Backfill::Parent(parent) => {
                id = parent;
                depth += 1;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Fixed(Value);
    #[async_trait]
    impl Records for Fixed {
        async fn record(&self, session: &str) -> Option<Header> {
            self.0.get(session).and_then(Value::as_object).cloned()
        }
    }

    /// `runStampOf` run in Node over these live records (`_liveSessions`, no stored copy): the
    /// expected stamps are its answers.
    #[tokio::test]
    async fn the_stamp_and_its_backfill_equal_nodes() {
        let records = json!({
            "stamped": { "run": { "kind": "webhook", "agentId": "bot", "name": "hook" } },
            "attended": { "run": null },
            "nonObj": { "run": 5 },
            "oldVia": { "delegation": { "via": "run", "rootAgentId": " botA ", "rootSessionId": "x", "run": { "kind": "webhook", "name": 0 } } },
            "oldViaHome": { "delegation": { "via": "run", "rootSessionId": "sess_home_my_bot1", "run": { "kind": "webhook", "name": "n" } } },
            "oldViaNotHome": { "delegation": { "via": "run", "rootSessionId": "agent_home_zzz", "run": { "kind": "other", "name": "n" } } },
            "oldViaNoOwner": { "delegation": { "via": "run", "rootSessionId": "x", "run": { "kind": "schedule" } } },
            "oldViaNumOwner": { "delegation": { "via": "run", "rootAgentId": 7, "rootSessionId": "x", "run": { "kind": "schedule" } } },
            "taskSrc": { "sourceType": "lead", "sourceName": " agent:my_bot-1@run " },
            "taskSrcBad": { "sourceType": "lead", "sourceName": "agent:my bot@run" },
            "taskSrcNL": { "sourceType": "lead", "sourceName": "agent:bot@run\n" },
            "taskSrcAgentOwned": { "owner": "Agent", "sourceType": "lead", "sourceName": "agent:bot@run" },
            "childOfStamped": { "owner": "agent", "parentSessionId": "stamped" },
            "childOfOwner": { "visibility": "AGENT-ONLY", "ownerSessionId": " taskSrc " },
            "grand": { "owner": "agent", "parentSessionId": "childOfStamped" },
            "orphan": { "owner": "agent", "parentSessionId": "missing" },
            "selfParent": { "owner": "agent", "parentSessionId": "selfParent" },
            "withDelegation": { "owner": "agent", "parentSessionId": "stamped", "delegation": { "via": "coding" } },
            "topLevel": {},
            "loopA": { "owner": "agent", "parentSessionId": "loopB" },
            "loopB": { "owner": "agent", "parentSessionId": "loopA" },
        });
        let lookup = Fixed(records.clone());
        let want = json!({
            "stamped": { "kind": "webhook", "agentId": "bot", "name": "hook" },
            "attended": null,
            "nonObj": null,
            "oldVia": { "kind": "webhook", "agentId": "botA", "name": "" },
            "oldViaHome": { "kind": "webhook", "agentId": "my.bot1", "name": "n" },
            "oldViaNotHome": null,
            "oldViaNoOwner": null,
            "oldViaNumOwner": null,
            "taskSrc": { "kind": "schedule", "agentId": "my_bot-1", "name": "" },
            "taskSrcBad": null,
            "taskSrcNL": { "kind": "schedule", "agentId": "bot", "name": "" },
            "taskSrcAgentOwned": null,
            "childOfStamped": { "kind": "webhook", "agentId": "bot", "name": "hook" },
            "childOfOwner": { "kind": "schedule", "agentId": "my_bot-1", "name": "" },
            "grand": { "kind": "webhook", "agentId": "bot", "name": "hook" },
            "orphan": null,
            "selfParent": null,
            "withDelegation": null,
            "topLevel": null,
            "loopA": null,
            "loopB": null,
            "nope": null,
        });
        for (id, expected) in want.as_object().unwrap() {
            assert_eq!(run_stamp_of(id, &lookup).await.unwrap_or(Value::Null), *expected, "{id}");
        }
    }

    /// Node reads a record from the store (`loadRecord`), loaded or not: a worker whose parent
    /// is not loaded here still has the parent's run, and an unloaded session has its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unloaded_session_and_an_unloaded_parent_answer_from_the_store() {
        use crate::session::thread_state::SessionThreads;
        use mixdog_core_ports::ports::threads::ThreadState;
        use crate::session::testing::Rig;
        use crate::session::tests::{real_store, start_thread};
        use mixdog_core_api::CallContext;

        let data = tempfile::tempdir().expect("data dir");
        let store = real_store(data.path()).await;
        let rig = Rig::new();
        let first = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
        let parent = start_thread(&first).await.id.clone();
        let child = start_thread(&first).await.id.clone();
        let threads = SessionThreads::new(first.clone());
        let run = json!({ "kind": "webhook", "agentId": "bot", "name": "hook" });
        let patch = |value: Value| value.as_object().expect("object").clone();
        threads.patch_header(&parent, patch(json!({ "run": run })), Vec::new()).await.expect("stamp");
        threads
            .patch_header(&child, patch(json!({ "owner": "agent", "parentSessionId": parent.as_str() })), Vec::new())
            .await
            .expect("link");

        // A directory that loaded nothing: the worker is opened, its parent is only stored.
        let second = Arc::new(SessionDirectory::new(rig.deps_on(store)));
        second.open_handle(&child, &CallContext::internal("test")).await.expect("open the worker");
        assert!(second.handle(&parent).is_none(), "the parent stays unloaded");
        let stamps = DirectoryRunStamps::new(second.clone());
        assert_eq!(stamps.stamp_of(&child).await, Some(run.clone()), "the worker has its stored parent's run");
        assert_eq!(stamps.stamp_of(&parent).await, Some(run), "an unloaded session has its own stored run");
        assert!(second.handle(&parent).is_none(), "reading a record loads nothing");
        assert_eq!(stamps.stamp_of(&ThreadId::from("sess_missing")).await, None);
    }}
