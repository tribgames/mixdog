//! The Lead pool row follows the Lead's workspace (1.4.5 `lead-worker-index.mjs`
//! `updateLeadWorkerCwd`).
//!
//! 1.4.5 keeps Lead rows in `lead-workers.json`; here a Lead's row is the `worker` map of its own
//! session header (migration folds the file in verbatim). Node takes every row of that file as a
//! Lead row whatever its `agent` (`normalizeLeadRows` stamps `agent: 'lead'`), so a folded row
//! may have no `agent`, or no `tag`. The session's own map is therefore its Lead row unless the
//! registry reads it as a worker row ([`normalize_row`]: a tag, a session id and an agent that is
//! not `lead`); an agent's map always has its tag. The registry excludes Lead rows from every
//! other read and write, so this is its one Lead-row writer: it moves the `cwd` of an existing
//! row and leaves every other field as it is. No row, nothing to write.
//!
//! 1.4.5's writer rewrites the document through `normalizeLeadRows`, so the row it leaves is the
//! normalized one (`tag`, `ownerSessionId`, `agent`, `status`, `stage`, `updatedAt`, `reapAt`
//! filled in), moved or not; the row written here is the same.
//!
//! A Lead's turns write its row (1.4.5 `lead-worker-index.mjs` `upsertLeadSession`, called by `turn-prepare.mjs:174` and
//! `turn-settle.mjs:105`): `running` as a turn starts, `idle` as it settles. The pool lists a Lead's agents under its row,
//! and drops a settled agent of a Lead that has none (`prune_orphans`), so a Lead with no row loses its finished agents and
//! every agent its listing does not see running. A Lead that has no row yet gets one at its next turn. A settled row
//! leaves at its reap deadline (1.4.5 `reap-timers.mjs`: the provider's terminal reap window, never before the pane's
//! hour from its finish), through the registry's deadline timer.
//!
//! Those rows live where 1.4.5 kept them, in a Lead index of their own (`WorkerStore::write_lead`, the core state's
//! `agent-lead-row:<session>`), not in the session's header: a write there is no change of the session's record, so it
//! re-reads no thread's agent status and only the pool is told. A row migrated into a header (above) is still read, moved
//! and reaped where it is, and a Lead's row in the index stands in for it.

use mixdog_agent::agent_tool::scope::positive_int;
use mixdog_agent::agent_tool::stamp::iso_from_ms;

use super::*;

/// `AGENT_PANE_VISIBLE_MS`: a settled Lead stays listed this long from its finish.
const AGENT_PANE_VISIBLE_MS: f64 = 60.0 * 60.0 * 1000.0;

/// What a turn writes on its Lead's pool row (`upsertLeadSession`'s `extra.status`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeadTurn {
    /// `turn-prepare.mjs`: `{ status: 'running', stage: 'running', turnStartedAt: now }`.
    Running,
    /// `turn-settle.mjs`: `{ status: 'idle', stage: 'idle' }`.
    Idle,
}

/// Whether a session's map is its Lead pool row: one the registry does not read as a worker row (as `pool_index` splits them).
pub(super) fn is_lead_map(map: &Row) -> bool {
    !clean(map.get("sessionId")).is_empty() && normalize_row(map).is_none()
}

/// `normalizeLeadRows` of one row: its existing keys stay where they are, the missing ones follow
/// in the order 1.4.5 spells them.
pub(super) fn normalized(row: &Row, id: &str) -> Row {
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
#[allow(clippy::cmp_owned, reason = "Serialized equality intentionally includes nested JSON key order; Value equality would change the persisted-row comparison")]
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
        // A row of the Lead index moves there (status, deadline and stamps unchanged); one removed is not brought back.
        self.leads_loaded().await;
        {
            let mut st = self.lock();
            if let Some(held) = st.lead_rows.get(&id).cloned() {
                if let Some(mut row) = held
                    && row.get("cwd") != Some(&Value::String(next.clone()))
                {
                    row.insert("cwd".into(), Value::String(next));
                    self.write_lead(&mut st, &id, Some(row));
                }
                return true;
            }
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
        if clean(current.get("sessionId")) != id || normalize_row(&current).is_some() {
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

    /// `upsertLeadSession(session, extra)`: the Lead's pool row as its turn starts or settles, built from its loaded header
    /// (`workerRowFromSession`) and replacing the row it had. `false` for a session that is not loaded or is not a Lead
    /// (an agent's session: `owner` `agent`, or an `agent` other than `lead`).
    pub fn upsert_lead_session(&self, session_id: &str, turn: LeadTurn) -> bool {
        let id = clean_str(session_id);
        let Some(session) = (!id.is_empty()).then(|| self.live.header(&id)).flatten() else { return false };
        let lower = |key: &str| clean(session.get(key)).to_lowercase();
        let agent = lower("agent");
        if lower("owner") == "agent" || (!agent.is_empty() && agent != "lead") {
            return false;
        }
        let now = self.now();
        let stamp = Value::String(iso_from_ms(now as i64));
        let text = |key: &str| {
            let value = clean(session.get(key));
            if value.is_empty() { Value::Null } else { Value::String(value) }
        };
        let running = turn == LeadTurn::Running;
        let status = if running { "running" } else { "idle" };
        let reap_ms = self.reap.terminal_reap_ms(&clean(session.get("provider")));
        let mut row = Row::new();
        row.insert("tag".into(), Value::String(format!("lead:{id}")));
        row.insert("sessionId".into(), Value::String(id.clone()));
        row.insert("parentSessionId".into(), Value::Null);
        row.insert("ownerSessionId".into(), Value::String(id.clone()));
        row.insert("agent".into(), Value::String("lead".into()));
        for key in ["provider", "model"] {
            row.insert(key.into(), text(key));
        }
        row.insert("preset".into(), text("presetName"));
        row.insert("effort".into(), text("effort"));
        row.insert("fast".into(), if session.get("fast") == Some(&Value::Bool(true)) { Value::Bool(true) } else { Value::Null });
        if session.get("autoEffort") == Some(&Value::Bool(false)) {
            row.insert("autoEffort".into(), Value::Bool(false));
        }
        row.insert("status".into(), Value::String(status.into()));
        row.insert("stage".into(), Value::String(status.into()));
        row.insert("createdAt".into(), if clean(session.get("createdAt")).is_empty() { stamp.clone() } else { text("createdAt") });
        row.insert("updatedAt".into(), stamp.clone());
        row.insert("lastUsedAt".into(), text("lastUsedAt"));
        // The pane lists a settled Lead for its hour from this stamp.
        row.insert("finishedAt".into(), if running { Value::Null } else { stamp.clone() });
        row.insert("turnStartedAt".into(), if running { stamp } else { Value::Null });
        row.insert("reapAt".into(), if reap_ms.is_finite() { Value::String(iso_from_ms(now as i64 + reap_ms as i64)) } else { Value::Null });
        row.insert("clientHostPid".into(), positive_int(session.get("clientHostPid")).map_or(Value::Null, Value::from));
        // The runtime that owns this status: the exit settles what this process still holds running.
        row.insert("runtimePid".into(), Value::from(u64::from(std::process::id())));
        row.insert("cwd".into(), text("cwd"));
        row.insert("task_id".into(), Value::Null);
        row.insert("permission".into(), text("permission"));
        row.insert("toolPermission".into(), text("toolPermission"));
        let mut st = self.lock();
        self.write_lead(&mut st, &id, Some(row));
        true
    }

    /// A Lead row written to the Lead index or removed from it: held as written (the pool and a workspace move read memory),
    /// then stored. Not a worker row: the exit's failure settlement of active rows (`st.active`) never takes it.
    pub(super) fn write_lead(&self, st: &mut State, id: &str, row: Option<Row>) {
        st.lead_rows.insert(id.to_owned(), row.clone());
        self.store.write_lead(id, row);
        self.rearm.notify_waiters();
    }

    /// Every Lead row there is now: the Lead index's, then a migrated header row of a Lead the index holds nothing of
    /// (`true`: the row is the index's).
    fn lead_rows_now(st: &State) -> Vec<(String, Row, bool)> {
        let indexed = st.lead_rows.iter().filter_map(|(id, row)| row.clone().map(|row| (id.clone(), row, true)));
        let migrated = st.maps.iter().filter(|(id, map)| is_lead_map(map) && !st.lead_rows.contains_key(*id)).map(|(id, map)| (id.clone(), map.clone(), false));
        indexed.chain(migrated).collect()
    }

    /// Removes a Lead's row wherever it is: from the Lead index, and a migrated header row.
    pub(super) fn remove_lead(&self, st: &mut State, id: &str) {
        if st.map(id).is_some_and(is_lead_map) {
            self.persist(st, id, None);
        }
        self.write_lead(st, id, None);
    }

    /// When a Lead row leaves (`reap-timers.mjs` `schedule`): at its reap deadline, never before the pane's hour from its
    /// finish; a row with no finish stamp is settled from its last update, as the boot recovery settles a row its runtime
    /// left running. A row with neither stamp (one migrated from 1.4.5 without them) is due at once: a cleanup of the core's,
    /// as 1.4.5 scheduled no reap for a row without `reapAt`. Never while the Lead's turn runs here.
    fn lead_reap_deadline(&self, id: &str, row: &Row) -> f64 {
        if self.live.running(id) {
            return f64::INFINITY;
        }
        let finished = Some(stamp_ms(row.get("finishedAt"))).filter(|ms| *ms > 0.0).unwrap_or_else(|| stamp_ms(row.get("updatedAt")));
        stamp_ms(row.get("reapAt")).max(finished + AGENT_PANE_VISIBLE_MS)
    }

    /// The next moment a Lead row comes due (ms); infinity when none will.
    pub(super) fn next_lead_reap_deadline(&self) -> f64 {
        let st = self.lock();
        Self::lead_rows_now(&st).iter().map(|(id, row, _)| self.lead_reap_deadline(id, row)).fold(f64::INFINITY, f64::min)
    }

    /// Removes every Lead row past its deadline (`removeLeadWorkerRow`): from the Lead index, or a migrated one from its header.
    pub(super) fn reap_lead_rows(&self) {
        let now = self.now();
        let mut st = self.lock();
        let due: Vec<(String, bool)> =
            Self::lead_rows_now(&st).into_iter().filter(|(id, row, _)| self.lead_reap_deadline(id, row) <= now).map(|(id, _, indexed)| (id, indexed)).collect();
        for (id, indexed) in due {
            if indexed {
                self.write_lead(&mut st, &id, None);
            } else {
                self.persist(&mut st, &id, None);
            }
        }
    }
}