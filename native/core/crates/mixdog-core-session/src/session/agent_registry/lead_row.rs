//! The Lead pool row follows the Lead's workspace (1.4.5 `lead-worker-index.mjs`
//! `updateLeadWorkerCwd`).
//!
//! 1.4.5 keeps Lead rows in `lead-workers.json`; here a Lead's row is the `worker` map of its own
//! session header (migration folds the file in), the map whose `agent` is `lead`. The registry
//! excludes those maps from every other read and write, so this is its one Lead-row writer: it
//! moves the `cwd` of an existing row and leaves every other field as it is. No row, nothing to
//! write.
//!
//! 1.4.5's writer rewrites the document through `normalizeLeadRows`, so the row it leaves is the
//! normalized one (`tag`, `ownerSessionId`, `agent`, `status`, `stage`, `updatedAt`, `reapAt`
//! filled in), moved or not; the row written here is the same.

use super::*;

/// `normalizeLeadRows` of one row: its existing keys stay where they are, the missing ones follow
/// in the order 1.4.5 spells them.
fn normalized(row: &Row, id: &str) -> Row {
    let mut out = row.clone();
    let text = |key: &str| clean(row.get(key));
    let or_null = |text: String| if text.is_empty() { Value::Null } else { Value::String(text) };
    out.insert("tag".into(), Value::String(format!("lead:{id}")));
    out.insert("sessionId".into(), Value::String(id.to_owned()));
    out.insert("ownerSessionId".into(), Value::String(id.to_owned()));
    out.insert("agent".into(), Value::String("lead".into()));
    let status = text("status");
    let stage = text("stage");
    out.insert("status".into(), Value::String(if status.is_empty() { "idle".into() } else { status.clone() }));
    out.insert("stage".into(), Value::String(if !stage.is_empty() { stage } else if !status.is_empty() { status } else { "idle".into() }));
    out.insert("updatedAt".into(), or_null(text("updatedAt")));
    out.insert("reapAt".into(), or_null(text("reapAt")));
    out
}

/// Key order counts: the row is compared as it is written.
fn same(a: &Row, b: &Row) -> bool {
    Value::Object(a.clone()).to_string() == Value::Object(b.clone()).to_string()
}

impl AgentRegistry {
    /// `updateLeadWorkerCwd(sessionId, cwd)`: `false` for a blank id or cwd, otherwise `true`,
    /// whether or not the session has a row to move.
    pub async fn update_lead_worker_cwd(&self, session_id: &str, cwd: &str) -> bool {
        let id = clean_str(session_id);
        let next = clean_str(cwd);
        if id.is_empty() || next.is_empty() {
            return false;
        }
        let header = self.store.header(&id).await;
        let stored = header.as_ref().and_then(|header| header.get("worker")).and_then(Value::as_object).cloned();
        let mut st = self.lock();
        // The header shows what was written: the stored map is the truth again. A session that is
        // not stored has no row.
        if header.is_none() || matches!((st.leads.get(&id), &stored), (Some(written), Some(shown)) if same(written, shown)) {
            st.leads.remove(&id);
        }
        let Some(current) = st.leads.get(&id).cloned().or(stored) else { return true };
        if !is_lead_pool_agent(current.get("agent")) || clean(current.get("sessionId")) != id {
            return true;
        }
        let mut row = normalized(&current, &id);
        if row.get("cwd") != Some(&Value::String(next.clone())) {
            row.insert("cwd".into(), Value::String(next));
        }
        if !same(&row, &current) {
            st.leads.insert(id.clone(), row.clone());
            self.store.write(&id, Some(row));
        }
        true
    }
}