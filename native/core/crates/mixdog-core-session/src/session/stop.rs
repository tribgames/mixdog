//! The stop of a running turn and what it hands back to the composer: Node's `createAbortAction`
//! (`session-api/intake/abort.mjs`), whose busy path is [`decide`] and whose idle path is the queue's hand-back.
//!
//! A run keeps the facts of the prompt that started it ([`PromptState`], Node's `flags.activePromptRestore`). The
//! control plane reads them when `turn/interrupt` arrives, decides what is given back, and records the hand-back
//! ([`Reclaim`]) for the actor, which applies it as the turn closes (the prompt leaves the history, the end row is not
//! shown, another device's composer is told through `thread/promptRestore`).
//!
//! `fixtures/phone-chat-core/phone-chat-core.json` (`record-phone-chat-core.mjs`) is Node's own run of
//! `createAbortAction` over every case [`decide`] is tested with.

use std::collections::HashMap;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_store::work_stops;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

/// The work a user Stop can target, owned by every stage it passes (a deferred start, a provenance read, an input read, the
/// run): its stable identity, allocated where the work is admitted (a direct start at its admission, a queued entry at its
/// enqueue, a completion batch from its first completion), and every source id through which it could run or be recreated
/// (its queue ids, its client submissions). A Stop freezes these, not whatever is busy later.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct WorkRef {
    pub id: String,
    pub qids: Vec<String>,
    pub submissions: Vec<String>,
    /// What a Stop before the work's run began hands back to a composer: a user's restorable prompt. `None`: the work is
    /// cancelled and consumed (a kickoff, a completion batch, a Goal or retry turn, a prompt no composer may take back).
    pub handback: Option<Handback>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Handback {
    pub text: String,
    pub device: String,
}

/// What a Stop still owes for its work: the prompt to give back to a composer, else the cancelled outcome.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Restore {
    pub text: String,
    pub ids: Vec<String>,
    pub device: String,
    /// When the Stop decided it (stamped by the Stop's record, which stores it): the restore's id and `at` come from it.
    pub at: i64,
}

impl Restore {
    /// Node's restore id (`restore-<at>-<submission ids>`, `abort.mjs` `reclaimInFlightPrompt`), derived only from what the Stop's
    /// record stores, so the live path, a repeated Stop and a recovery after a restart name it alike, and the Stop's reply
    /// carries the same id as the notification.
    pub fn id(&self) -> String {
        format!("restore-{}-{}", self.at, self.ids.join(","))
    }
}

impl WorkRef {
    /// Every identity of the work the store's receipt (`stoppedWork`) keys.
    pub fn identities(&self) -> Vec<String> {
        std::iter::once(work_stops::work(&self.id))
            .chain(self.qids.iter().map(|qid| work_stops::queued(qid)))
            .chain(self.submissions.iter().map(|id| work_stops::submission(id)))
            .collect()
    }

    /// The ids a hand-back names: the submissions a composer recognises, else the queue ids.
    pub fn restore_ids(&self) -> Vec<String> {
        if self.submissions.is_empty() { self.qids.clone() } else { self.submissions.clone() }
    }

    /// The hand-back a Stop before the run began owes.
    pub fn restore(&self) -> Option<Restore> {
        self.handback.as_ref().filter(|handback| !handback.text.is_empty()).map(|handback| Restore { text: handback.text.clone(), ids: self.restore_ids(), device: handback.device.clone(), at: 0 })
    }

    /// The `work_stop{stopped}` body (`mixdog_store::work_stops`). `row`: the stopped run's input row, which a hand-back takes out
    /// of the transcript and the model context (the rewind is part of what the Stop owes).
    pub fn stop_body(&self, turn: Option<&str>, row: Option<&str>, restore: Option<&Restore>) -> Value {
        let mut body = json!({
            "work": [self.id],
            "queues": self.qids,
            "submissions": self.submissions,
            "disposition": if restore.is_some() { "handedBack" } else { "cancelled" },
        });
        if let Some(turn) = turn {
            body["turn"] = json!(turn);
        }
        if let Some(row) = row.filter(|_| restore.is_some()) {
            body["row"] = json!(row);
        }
        if let Some(restore) = restore {
            body["restore"] = json!({ "text": restore.text, "ids": restore.ids, "device": restore.device, "at": restore.at });
        }
        body
    }
}

/// The restore an owed Stop's body names.
pub(crate) fn owed_restore(body: &Value) -> Option<Restore> {
    let restore = body.get("restore")?;
    let text = restore.get("text").and_then(Value::as_str).filter(|text| !text.is_empty())?.to_owned();
    let ids = restore.get("ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let device = restore.get("device").and_then(Value::as_str).unwrap_or_default().to_owned();
    let at = restore.get("at").and_then(Value::as_i64).unwrap_or_default();
    Some(Restore { text, ids, device, at })
}

/// The input row an owed hand-back still has to take out of the transcript.
pub(crate) fn owed_row(body: &Value) -> Option<String> {
    body.get("row").and_then(Value::as_str).filter(|row| !row.is_empty()).map(str::to_owned)
}

/// The answer a Stop's caller waits for: success only once its record is durable, else the storage failure.
///
/// The one exception to the rule that a Stop's disposition survives a crash: a Stop without a durable acknowledgement. That is
/// a record that could not be written (its caller hears `ESTOPNOTSAVED`, `actor/work_stop.rs` `stop_durable`), or a crash
/// before the record's save completed, a request interrupted mid-way included (a room Stop whose member saves had not all
/// landed). The cancellation fired in this process and stands while it lives, but for every target whose record was not yet
/// durable nothing on disk keeps the work from running after a restart; only a success answer guarantees that.
///
/// The accepted limit of a hand-back (Node 1.4.5's level): a crash or a lost connection between the Stop and the composer
/// applying the text can lose the text. The stopped work still never runs again.
pub(crate) type StopWait = oneshot::Receiver<Result<(), CoreError>>;

/// A hand-back a Stop still owes, as Node offered it (`abort.mjs`): returned in the Stop's own reply to the canceller
/// (`by_reply`), or published in the session state for the owning device (`promptRestore`). It is settled once its rewind is
/// done (`rewound`: the stopped turn's prompt row left the transcript, or there was none) and it was offered; nothing waits for
/// a composer to acknowledge it. A restart before it settled offers it once more under the same id, then settles it.
#[derive(Clone, Debug)]
pub(crate) struct OwedHandback {
    pub restore: Restore,
    pub rewound: bool,
    pub by_reply: bool,
}

enum Durability {
    Pending(Vec<oneshot::Sender<Result<(), CoreError>>>),
    Done(Result<(), CoreError>),
}

/// The actor's Stops: the identities each froze, latched at the Stop's linearization point and kept whatever its save does (a
/// failed save does not undo the fired cancellation, nor make the work runnable again in this process), and the durability of each
/// Stop's record, which every request that joined it is answered with.
#[derive(Default)]
pub(crate) struct StopBook {
    latched: HashMap<String, String>,
    durable: HashMap<String, Durability>,
    /// The hand-backs still owed, in the order they were owed.
    owed: Vec<(String, OwedHandback)>,
    /// The Stops whose `settled` record was accepted: one settlement each.
    settled: std::collections::HashSet<String>,
}

impl StopBook {
    pub fn owe(&mut self, sid: &str, owed: OwedHandback) {
        self.owed.retain(|(owed, _)| owed != sid);
        self.owed.push((sid.to_owned(), owed));
    }

    pub fn owed_mut(&mut self, sid: &str) -> Option<&mut OwedHandback> {
        self.owed.iter_mut().find(|(owed, _)| owed == sid).map(|(_, owed)| owed)
    }

    pub fn owed(&self, sid: &str) -> Option<&OwedHandback> {
        self.owed.iter().find(|(owed, _)| owed == sid).map(|(_, owed)| owed)
    }

    pub fn unowe(&mut self, sid: &str) {
        self.owed.retain(|(owed, _)| owed != sid);
    }

    /// Marks Stop `sid` settled; false when it already was.
    pub fn settle(&mut self, sid: &str) -> bool {
        self.settled.insert(sid.to_owned())
    }

    /// The Stop already latched on any identity of `work`.
    pub fn latched(&self, work: &WorkRef) -> Option<String> {
        work.identities().iter().find_map(|identity| self.latched.get(identity)).cloned()
    }

    pub fn latched_identity(&self, identity: &str) -> Option<&str> {
        self.latched.get(identity).map(String::as_str)
    }

    /// Freezes `work` under Stop `sid`: its record is about to be accepted.
    pub fn latch(&mut self, work: &WorkRef, sid: &str) {
        for identity in work.identities() {
            self.latched.entry(identity).or_insert_with(|| sid.to_owned());
        }
        self.durable.entry(sid.to_owned()).or_insert_with(|| Durability::Pending(Vec::new()));
    }

    /// A waiter of Stop `sid`'s durability: answered when its record lands or fails, at once when that is known. A Stop this process
    /// did not record (one read back from the log) is durable.
    pub fn join(&mut self, sid: &str) -> StopWait {
        let (tx, rx) = oneshot::channel();
        match self.durable.get_mut(sid) {
            Some(Durability::Pending(waiters)) => waiters.push(tx),
            Some(Durability::Done(result)) => drop(tx.send(result.clone())),
            None => drop(tx.send(Ok(()))),
        }
        rx
    }

    /// Stop `sid`'s record landed or failed: every joined request hears it.
    pub fn done(&mut self, sid: &str, result: Result<(), CoreError>) {
        if let Some(Durability::Pending(waiters)) = self.durable.insert(sid.to_owned(), Durability::Done(result.clone())) {
            for waiter in waiters {
                let _ = waiter.send(result.clone());
            }
        }
    }

    /// Whether Stop `sid`'s record failed to be saved (its settlement then writes nothing).
    pub fn failed(&self, sid: &str) -> bool {
        matches!(self.durable.get(sid), Some(Durability::Done(Err(_))))
    }
}

/// A stop that handed the prompt back, for the actor to apply when the turn closes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Reclaim {
    /// The text that left the prompt history (`promptHistoryWithout`).
    pub text: String,
    /// The submissions it came from.
    pub ids: Vec<String>,
    /// Another device cancelled: the device that sent the prompt, which gets it through `thread/promptRestore`.
    pub handoff: Option<String>,
}

/// The prompt that started a run.
#[derive(Debug)]
pub(crate) struct PromptState {
    facts: Mutex<Facts>,
    /// A test's stop stands here, between its reads and its decision, until the test lets it go.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) pause: Mutex<Option<(std::sync::Arc<tokio::sync::Notify>, std::sync::Arc<tokio::sync::Notify>)>>,
    /// Whether the facts could be taken (so an output commit could land) between a stop's decision and its record: `Some(false)` when the
    /// stop holds them across both, as Node's `abort` has no await between (`abort.mjs:131-205`).
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) between: Mutex<Option<bool>>,
}

/// What [`decide`] reads of the prompt.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Facts {
    /// `promptDisplayText`, trimmed.
    pub text: String,
    /// `clientSubmissionId`s (Node's `submittedIds`).
    pub ids: Vec<String>,
    /// The device that sent it (`transcriptMeta.device`).
    pub device: String,
    /// A user prompt that may go back to a composer (`options.restorable !== false`, not a kickoff or a runtime's turn).
    pub restorable: bool,
    /// The turn produced output: nothing is handed back after that (`commitPromptRestore`).
    pub committed: bool,
    /// The prompt in the shape of a queue entry (`{message, options}`): what the attachments are read from.
    pub entry: Value,
    /// The user's Stop reached this work: its cancellation provenance, set with the decision and never inferred from the run's
    /// outcome, `restorable` or the abort reason (which reads `interrupt` when steering is pending). A user Stop is the terminal
    /// disposition of the work: it is handed back to a composer ([`Reclaim`], which alone suppresses the cancelled end), or
    /// cancelled and consumed (its dequeue is its consumption). It never requeues the work and the work never runs again without a
    /// new user action. This departs from Node 1.4.5, which put an uncommitted kickoff or ordinary notification back at the front of
    /// the queue after a Stop (`abort.mjs:61-90,160-199`, `drain.mjs:112-140`); the user asked for the departure. Interruptions
    /// that are no user Stop (a failed save, a deferred start's fresh save, a dequeue lost to a compaction or the core's hold,
    /// crash recovery) keep their recovery: they never pass through here. This flag is the prompt's view only: the disposition's
    /// authority is the Stop's durable `work_stop` record over the run's [`WorkRef`] (`actor/work_stop.rs`).
    pub user_stopped: bool,
    pub reclaim: Option<Reclaim>,
}

impl Facts {
    /// `Boolean(pastedImages || pastedTexts || content)`.
    pub fn has_attachments(&self) -> bool {
        let present = |pointer: &str| self.entry.pointer(pointer).is_some_and(|value| !value.is_null());
        present("/options/pastedImages")
            || present("/options/pastedTexts")
            || self.entry.get("message").and_then(Value::as_array).is_some_and(|parts| parts.iter().any(|part| part["type"] == "file"))
    }
}

impl PromptState {
    pub fn new(facts: Facts) -> Self {
        Self {
            facts: Mutex::new(facts),
            #[cfg(any(test, feature = "test-support"))]
            pause: Mutex::new(None),
            #[cfg(any(test, feature = "test-support"))]
            between: Mutex::new(None),
        }
    }

    /// `(reached, go)`: the stop signals `reached` when it stands between its reads and its decision, and waits for `go`.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) async fn paused(&self) {
        let held = self.pause.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some((reached, go)) = held {
            reached.notify_one();
            go.notified().await;
        }
    }

    fn facts(&self) -> std::sync::MutexGuard<'_, Facts> {
        self.facts.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn snapshot(&self) -> Facts {
        self.facts().clone()
    }

    /// `commitPromptRestore`: the turn produced output, so the prompt is no longer the user's to take back.
    pub fn commit(&self) {
        let mut facts = self.facts();
        facts.committed = true;
        facts.restorable = false;
    }

    /// [`decide`] over the prompt's facts as they are at this instant and the hand-back recorded in the same hold of the lock: an
    /// output commit lands wholly before it (nothing is handed back) or wholly after it (the stop already took the prompt), as Node's
    /// `abort` reads, decides and records with no await between (`abort.mjs:131-205`).
    pub fn decide_and_record(&self, restore_prompt: Option<bool>, canceller: &str, steering: bool, unreadable: bool) -> Decision {
        let mut facts = self.facts();
        let decision = decide(&facts, restore_prompt, canceller, steering, unreadable);
        #[cfg(any(test, feature = "test-support"))]
        self.between.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).replace(self.facts.try_lock().is_ok());
        // Node hands back at once and empties what it handed (`restorable = false`, `requeueEntries = []`, `abort.mjs:200-201`), so a
        // second Stop before the turn ended finds nothing; the core hands back at the turn's end, so the first's record stays.
        facts.restorable = false;
        facts.user_stopped = true;
        if decision.reclaim.is_some() {
            facts.reclaim = decision.reclaim.clone();
        }
        decision
    }

    pub fn take_reclaim(&self) -> Option<Reclaim> {
        self.facts().reclaim.take()
    }
}

/// What a stop decided.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Decision {
    /// The reason the turn is aborted with (`abortGoalTurn`): `interrupt` when a steering prompt is queued, else a
    /// stop that keeps the prompt in the transcript, else the user's stop.
    pub reason: Reason,
    /// What the canceller's composer gets (`restoreText`), empty when the text travels to another device.
    pub restore_text: String,
    pub restored_ids: Vec<String>,
    /// The pasted images and texts a steering prompt left behind, handed back to be discarded.
    pub discard_images: bool,
    pub discard_texts: bool,
    pub reclaim: Option<Reclaim>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    /// `interrupt`: the turn was redirected.
    Interrupt,
    /// `user-cancel-keep-prompt`: a user stop that leaves the prompt in the stored transcript.
    KeepPrompt,
    /// The user's stop; a turn that produced nothing is rewound.
    UserCancel,
}

/// Whether the prompt is asked back from the attachment store at all: the stop wants it handed back and a prompt that
/// carries attachments reads them first (`hydrateTolerantly`, before the turn is aborted).
pub(crate) fn wants_restore(facts: &Facts, restore_prompt: Option<bool>, canceller: &str, steering: bool) -> bool {
    let cross = cross_device(facts, canceller);
    restore_prompt != Some(false) && facts.restorable && !steering && !(cross && facts.has_attachments())
}

fn cross_device(facts: &Facts, canceller: &str) -> bool {
    !canceller.is_empty() && !facts.device.is_empty() && canceller != facts.device
}

/// `abort`'s busy path (`abort.mjs:92-221`) over the run's prompt. `unreadable`: the attachments could not be read back,
/// so the prompt is kept as `hydrateFailure` keeps it.
pub(crate) fn decide(facts: &Facts, restore_prompt: Option<bool>, canceller: &str, steering: bool, unreadable: bool) -> Decision {
    let cross = cross_device(facts, canceller);
    let wants = wants_restore(facts, restore_prompt, canceller, steering);
    let can_restore = wants && !unreadable;
    let restore_text = if can_restore { facts.text.clone() } else { String::new() };
    let keeps_prompt = !can_restore && facts.restorable && !facts.committed;
    let reason = if steering {
        Reason::Interrupt
    } else if keeps_prompt {
        Reason::KeepPrompt
    } else {
        Reason::UserCancel
    };
    let handed_over = cross && !restore_text.is_empty();
    // `reclaimInFlightPrompt` runs for a prompt handed back to a composer only: no work is put back in the queue.
    let reclaim = (!restore_text.is_empty()).then(|| Reclaim {
        text: restore_text.clone(),
        ids: facts.ids.clone(),
        handoff: handed_over.then(|| facts.device.clone()),
    });
    Decision {
        reason,
        restored_ids: if restore_text.is_empty() || handed_over { Vec::new() } else { facts.ids.clone() },
        restore_text: if handed_over { String::new() } else { restore_text },
        discard_images: facts.restorable && steering && has(&facts.entry, "/options/pastedImages"),
        discard_texts: facts.restorable && steering && has(&facts.entry, "/options/pastedTexts"),
        reclaim,
    }
}

fn has(entry: &Value, pointer: &str) -> bool {
    entry.pointer(pointer).is_some_and(|value| !value.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Two Stops before the turn ended (`abort.mjs:113` twice while busy): the first hands the prompt back, and the second finds
    /// nothing left to hand back and takes nothing from the first. A runtime's prompt (a kickoff) is cancelled and consumed: no
    /// reclaim, so the cancelled end is shown and nothing is put back in the queue.
    #[test]
    fn a_second_stop_before_the_turn_ended_keeps_the_first_stops_hand_back() {
        let user = PromptState::new(Facts { text: "p".into(), ids: vec!["s".into()], device: "A".into(), restorable: true, entry: json!({ "options": {} }), ..Facts::default() });
        let first = user.decide_and_record(None, "A", false, false);
        assert!(first.reclaim.is_some());
        let second = user.decide_and_record(None, "A", false, false);
        assert_eq!((second.restore_text.as_str(), second.reclaim.as_ref()), ("", None));
        assert_eq!(user.snapshot().reclaim, first.reclaim);
        let kickoff = PromptState::new(Facts { text: "k".into(), ids: vec!["r".into()], entry: json!({ "options": {} }), ..Facts::default() });
        for _ in 0..2 {
            let stop = kickoff.decide_and_record(None, "A", false, false);
            assert_eq!(stop.reclaim, None, "a user-stopped kickoff is no hand-back and no requeue");
            assert_eq!(stop.reason, Reason::UserCancel);
        }
        assert!(kickoff.snapshot().user_stopped && kickoff.snapshot().reclaim.is_none());
    }









}
