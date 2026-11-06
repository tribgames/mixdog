//! The real [`RunStamps`]: the `run` stamped on a stored session (`runStampOf`,
//! `human-gate/delegation.mjs:108`), with Node's backfill of records older than the stamp
//! (`stampRun`, `legacyRunOf`). It answers from the headers of the threads this process has
//! loaded, without waiting: a session or parent that is not loaded has no record to read.
//!
//! Node also keeps a backfilled run on the live record so its next save persists it; the
//! answer is the same without, because the backfill derives the same run every time.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::SessionDirectory;
use crate::rooms::ids::agent_id_of_home_session;
use crate::run_host::unattended::RunStamps;
use crate::workflow::ids::truthy;

/// `MAX_PATH`: how far up the parents a backfill walks.
const MAX_PATH: usize = 32;

pub struct DirectoryRunStamps {
    directory: Arc<SessionDirectory>,
}

impl DirectoryRunStamps {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }
}

impl RunStamps for DirectoryRunStamps {
    fn stamp_of(&self, thread: &ThreadId) -> Option<Value> {
        run_stamp_of(thread.as_str(), &|id| {
            self.directory.handle(&ThreadId::from(id)).map(|handle| handle.cell.header.load_full().as_ref().clone())
        })
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

type Lookup<'a> = &'a dyn Fn(&str) -> Option<Header>;

/// `legacyRunOf`: the run a record from before the stamp was started by, from what it recorded.
fn legacy_run_of(id: &str, record: &Header, depth: usize, lookup: Lookup<'_>) -> Option<Value> {
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
        return run_stamp(run.get("kind"), owner.as_ref(), run.get("name"));
    }
    if !agent_owned(record) && clean(record.get("sourceType")) == "lead" {
        if let Some(bot) = task_source_bot(&clean(record.get("sourceName"))) {
            return run_stamp(Some(&Value::from("schedule")), Some(&Value::from(bot)), None);
        }
    }
    let parent = parent_of(record);
    if parent.is_empty() || parent == id || old.is_some_and(Value::is_object) || depth >= MAX_PATH {
        return None;
    }
    let parent_record = lookup(&parent)?;
    stamp_run(&parent, &parent_record, depth + 1, lookup)
}

/// `stampRun`: the record's stamp (`null` = attended), else the run it recorded before stamps.
fn stamp_run(id: &str, record: &Header, depth: usize, lookup: Lookup<'_>) -> Option<Value> {
    match record.get("run") {
        Some(run) => run.is_object().then(|| run.clone()),
        None => legacy_run_of(id, record, depth, lookup),
    }
}

/// `runStampOf(sessionId)` over the records `lookup` holds.
pub fn run_stamp_of(session: &str, lookup: Lookup<'_>) -> Option<Value> {
    let id = mixdog_js::js_trim(session);
    if id.is_empty() {
        return None;
    }
    stamp_run(id, &lookup(id)?, 0, lookup)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `runStampOf` run in Node over these live records (`_liveSessions`, no stored copy): the
    /// expected stamps are its answers.
    #[test]
    fn the_stamp_and_its_backfill_equal_nodes() {
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
        let lookup = |id: &str| records.get(id).and_then(Value::as_object).cloned();
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
            assert_eq!(run_stamp_of(id, &lookup).unwrap_or(Value::Null), *expected, "{id}");
        }
    }
}
