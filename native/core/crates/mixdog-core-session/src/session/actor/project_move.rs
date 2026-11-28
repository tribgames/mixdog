//! A session's Project move (`setSessionProject`). The actor alone holds the Project the session is wanted in: the header's
//! [`PENDING_PROJECT_MOVE`], written in its message order. It carries the session there once it is settled, one carry at a
//! time, until where the session is equals what is wanted. A carry holds the session as a running turn does.

use super::*;
use crate::session::thread_settings::PENDING_PROJECT_MOVE;
use crate::session::thread_settings::PROJECT_MOVE_FAILED;
use crate::session::thread_settings::failure_text;
use crate::session::thread_settings::project_identity;
use crate::session::thread_settings::session_project_key;

/// The carry under way: the request it was begun for, as the record held it then, and the caller that waits on its end when
/// it began at once.
pub(super) struct Carry {
    pending: Value,
    tx: Option<Waiter>,
}

/// The Project a pending record asks for, as an identity ('' for the task workspace).
fn asked(pending: &Value) -> String {
    project_identity(pending.get("projectPath").and_then(Value::as_str))
}

impl SessionActor {
    /// A move is being carried out: the session is held as by a running turn ([`Self::turn_held`], [`Self::ui_busy`]).
    pub(super) fn carrying(&self) -> bool {
        self.carry.is_some()
    }

    /// A move is recorded or under way: no turn starts ([`Self::starts_gated`]).
    pub(super) fn move_held(&self) -> bool {
        self.carrying() || self.projected.header.contains_key(PENDING_PROJECT_MOVE)
    }

    /// The registered Project the session is in, as an identity ('' for none), among `projects`.
    fn project_key(&self, projects: &[String]) -> String {
        let header = &self.projected.header;
        let row = json!({
            "projectPath": header.get("desktopSession").and_then(|desktop| desktop.get("projectPath")),
            "cwd": header.get("cwd"),
            "workspace": header.get("workspace"),
        });
        session_project_key(&row, projects)
    }

    /// A change of the move's record nobody is answered for: a failed save holds it and writes it again.
    fn accept_move_change(&mut self, change: HeaderChange) {
        if !change.set.is_empty() || !change.unset.is_empty() {
            let meta = Record::Meta(MetaRecord { op: None, change: Slot::Inline(change) });
            self.accept_record(meta, Class::Normal, Display::None, Vec::new(), Vec::new());
        }
    }

    /// A move is wanted (recorded or under way) from now, or no longer: checked after every step ([`Self::pump`]). The
    /// prompts queued while it was are released by the queue's gate ([`Self::drain_gated`]), which holds them through a
    /// compaction; those queued before it wait for what they waited for (a reopened session's for its resume).
    pub(super) fn follow_move_hold(&mut self) {
        let held = self.move_held();
        if held && self.move_base.is_none() {
            self.move_base = Some(self.projected.queue.iter().map(|queued| queued.qid.clone()).collect());
        } else if !held && let Some(base) = self.move_base.take() {
            self.drain_held |= self.manual_compact_due || self.projected.queue.iter().any(|queued| !base.contains(&queued.qid));
        }
    }

    /// Nothing runs that a move waits for: no turn running, admitted, starting or settling, no compaction, clear or other
    /// move. A start admitted before the move was asked for runs first, as a running turn does.
    fn settled_for_move(&self) -> bool {
        !self.carrying()
            && self.deferred_start.is_none()
            && !self.deleting
            && !self.tombstoned
            && !self.cell.closed.load(SeqCst)
            && self.run.is_none()
            && !self.starting
            && !self.settling
            && !self.turn_pending()
            && !self.turn_unsettled()
            && !self.compaction_held()
            && self.compactions == 0
            && !self.idle_clearing
            && self.clear_holds == 0
    }

    /// `Inbox::ProjectMove`: the session is wanted in `target` (a registered Project's path, `None` for the task workspace),
    /// `projects` being the registered Projects' identities. What that means is decided here, against the session as it is at
    /// this message: wanted where it is, nothing stays pending; wanted where the carry under way goes, that carry's own
    /// request stands again; otherwise the request is recorded, a later one replacing it. So a request for the Project a
    /// carry left is carried out after that carry, back. A settled session begins the move now and the request is answered
    /// by the move itself; otherwise it is answered once the record is written.
    pub(super) fn project_move(&mut self, target: Option<String>, projects: Vec<String>, tx: Waiter) {
        if !self.outbox.has_room(Class::Normal) {
            let _ = tx.send(Err(CoreError::WindowFull { thread_id: self.id.clone() }));
            return;
        }
        let wanted = project_identity(target.as_deref());
        let pending = match &self.carry {
            Some(carry) if asked(&carry.pending) == wanted => Some(carry.pending.clone()),
            None if self.project_key(&projects) == wanted => None,
            _ => Some(json!({ "projectPath": target, "requestedAt": self.deps.clock.now_ms() })),
        };
        self.projects = Some(projects);
        let header = &self.projected.header;
        let mut change = HeaderChange::default();
        match &pending {
            Some(pending) if header.get(PENDING_PROJECT_MOVE) != Some(pending) => drop(change.set.insert(PENDING_PROJECT_MOVE.to_owned(), pending.clone())),
            None if header.contains_key(PENDING_PROJECT_MOVE) => change.unset.push(PENDING_PROJECT_MOVE.to_owned()),
            _ => {}
        }
        if header.contains_key(PROJECT_MOVE_FAILED) {
            change.unset.push(PROJECT_MOVE_FAILED.to_owned());
        }
        match pending {
            Some(pending) if self.settled_for_move() => {
                self.accept_move_change(change);
                self.begin_move(pending, Some(tx));
            }
            _ => self.write_header_change(change, tx),
        }
    }

    /// The recorded move is taken up once the session is settled, checked after every step ([`Self::pump`]): a session
    /// already where it is wanted (a request for the Project a failed carry never left) only drops the record.
    pub(super) fn begin_due_move(&mut self) {
        if self.recovering || !self.settled_for_move() {
            return;
        }
        let Some(pending) = self.projected.header.get(PENDING_PROJECT_MOVE).cloned() else { return };
        // A record an earlier process left names no Projects to compare with: it was recorded as a move, and is carried out.
        if self.projects.as_ref().is_some_and(|projects| self.project_key(projects) == asked(&pending)) {
            let change = HeaderChange { unset: vec![PENDING_PROJECT_MOVE.to_owned()], ..HeaderChange::default() };
            return self.accept_move_change(change);
        }
        self.begin_move(pending, None);
    }

    fn begin_move(&mut self, pending: Value, tx: Option<Waiter>) {
        let carried = self.deps.turn_admission.settled_move(self.id.as_str(), pending.clone());
        self.carry = Some(Carry { pending, tx });
        let Some(carried) = carried else {
            return self.project_moved(Err(mixdog_core_base::support::failed("thread-settings", "This host cannot move a session to another project.")));
        };
        let jobs = self.jobs_tx.clone();
        tokio::spawn(async move {
            let result = carried.await;
            let _ = jobs.send(JobDone::ProjectMoved(result));
        });
    }

    /// The carry ended. Its result is its own request's: while the record still holds that request the record goes (the
    /// folder's own write took it with it when the carry succeeded) and a failure nobody waits on is kept
    /// ([`PROJECT_MOVE_FAILED`]); a request that replaced it stays recorded, nothing of this result is, and it is taken up
    /// next ([`Self::begin_due_move`]). What queued behind the move goes on once none is wanted ([`Self::follow_move_hold`]).
    pub(super) fn project_moved(&mut self, result: Result<(), CoreError>) {
        let Some(Carry { pending, tx }) = self.carry.take() else { return };
        // A delete waited for the carry as it waits for a turn: nothing more is written.
        if self.deleting {
            if let Some(tx) = tx {
                let _ = tx.send(result.map(|()| Reply::Value(json!({}))));
            }
            return self.delete_turn_ended();
        }
        let wanted = self.projected.header.get(PENDING_PROJECT_MOVE) == Some(&pending);
        let mut change = HeaderChange::default();
        if wanted {
            change.unset.push(PENDING_PROJECT_MOVE.to_owned());
        }
        match (result, tx) {
            (Ok(()), Some(tx)) => self.write_header_change(change, tx),
            (Ok(()), None) => self.accept_move_change(change),
            // The caller hears the failure once the record's change is written, so it never reads the move it asked for as
            // still pending.
            (Err(error), Some(tx)) => {
                let (written_tx, written) = oneshot::channel();
                self.write_header_change(change, written_tx);
                tokio::spawn(async move {
                    let _ = written.await;
                    let _ = tx.send(Err(error));
                });
            }
            (Err(error), None) => {
                if wanted {
                    let at = self.deps.clock.now_ms();
                    let failed =
                        json!({ "projectPath": pending.get("projectPath").cloned().unwrap_or(Value::Null), "message": failure_text(&error), "at": at });
                    change.set.insert(PROJECT_MOVE_FAILED.to_owned(), failed);
                }
                self.accept_move_change(change);
            }
        }
        self.run_deferred_prune();
        self.try_unload();
    }
}
