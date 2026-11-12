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

use std::sync::Mutex;

use serde_json::Value;

/// A stop that handed the prompt back, for the actor to apply when the turn closes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Reclaim {
    /// The text that left the prompt history (`promptHistoryWithout`).
    pub text: String,
    /// The submissions it came from.
    pub ids: Vec<String>,
    /// Another device cancelled: the device that sent the prompt, which gets it through `thread/promptRestore`.
    pub handoff: Option<String>,
    /// The runtime's own prompt the stop found uncommitted, as the queue entry that goes back to the front of the queue and
    /// runs again (`requeueEntriesFront`, `abort.mjs:90`).
    pub requeue: Option<Value>,
}

/// The prompt that started a run.
#[derive(Debug)]
pub(crate) struct PromptState {
    facts: Mutex<Facts>,
    /// A test's stop stands here, between its reads and its decision, until the test lets it go.
    #[cfg(test)]
    pub(crate) pause: Mutex<Option<(std::sync::Arc<tokio::sync::Notify>, std::sync::Arc<tokio::sync::Notify>)>>,
    /// Whether the facts could be taken (so an output commit could land) between a stop's decision and its record: `Some(false)` when the
    /// stop holds them across both, as Node's `abort` has no await between (`abort.mjs:131-205`).
    #[cfg(test)]
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
    /// A runtime's own prompt (a kickoff), as its queue entry: Node's drain gives the turn the batch's entries that are not the
    /// user's to edit as `requeueOnAbort` (`drain.mjs:140`), and a stop before the turn committed puts them back
    /// (`abort.mjs:160-165`).
    pub requeue: Option<Value>,
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
            #[cfg(test)]
            pause: Mutex::new(None),
            #[cfg(test)]
            between: Mutex::new(None),
        }
    }

    /// `(reached, go)`: the stop signals `reached` when it stands between its reads and its decision, and waits for `go`.
    #[cfg(test)]
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

    /// Records a hand-back; `restorable` ends either way (`restoreState.restorable = false`).
    pub fn record(&self, reclaim: Option<Reclaim>) {
        let mut facts = self.facts();
        facts.restorable = false;
        facts.reclaim = reclaim;
    }

    /// [`decide`] over the prompt's facts as they are at this instant and the hand-back recorded in the same hold of the lock: an
    /// output commit lands wholly before it (nothing is handed back) or wholly after it (the stop already took the prompt), as Node's
    /// `abort` reads, decides and records with no await between (`abort.mjs:131-205`).
    pub fn decide_and_record(&self, restore_prompt: Option<bool>, canceller: &str, steering: bool, unreadable: bool) -> Decision {
        let mut facts = self.facts();
        let decision = decide(&facts, restore_prompt, canceller, steering, unreadable);
        #[cfg(test)]
        self.between.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).replace(self.facts.try_lock().is_ok());
        // Node hands back at once and empties what it handed (`restorable = false`, `requeueEntries = []`, `abort.mjs:200-201`), so a
        // second Stop before the turn ended finds nothing; the core hands back at the turn's end, so the first's record stays.
        facts.restorable = false;
        facts.requeue = None;
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
    let requeue = facts.requeue.clone().filter(|_| !facts.committed);
    // `reclaimInFlightPrompt` runs for a prompt handed back and for entries put back in the queue (`abort.mjs:192-199`).
    let reclaim = (!restore_text.is_empty() || requeue.is_some()).then(|| Reclaim {
        text: restore_text.clone(),
        ids: facts.ids.clone(),
        handoff: handed_over.then(|| facts.device.clone()),
        requeue,
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

    /// Node's own `createAbortAction` run (`record-phone-chat-core.mjs`) is the oracle: every busy case it recorded.
    #[test]
    fn decide_matches_the_recorded_node_aborts() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/phone-chat-core/phone-chat-core.json");
        let recorded: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut replayed = 0;
        for case in recorded["cases"].as_array().unwrap().iter().filter(|case| case["kind"] == "abort") {
            let options = &case["options"];
            // The wire's `turn/interrupt` only ever stops as the user; a runtime's own reasons are not a client's to name.
            if options.get("reason").is_some() {
                continue;
            }
            let name = case["name"].as_str().unwrap();
            let submit = &case["submit"];
            let text = case["prompt"].as_str().unwrap().trim().to_owned();
            let committed = case["output"]["text"].as_str().is_some_and(|output| !output.trim().is_empty());
            let facts = Facts {
                text,
                ids: vec![submit["id"].as_str().unwrap().to_owned()],
                device: submit["transcriptMeta"]["device"].as_str().unwrap_or_default().to_owned(),
                restorable: submit["kickoff"] != true && !committed,
                committed,
                entry: json!({ "options": { "pastedImages": submit["pastedImages"], "pastedTexts": submit["pastedTexts"] } }),
                requeue: None,
                reclaim: None,
            };
            let restore_prompt = options.get("restorePrompt").and_then(Value::as_bool);
            let canceller = options["device"].as_str().unwrap_or_default();
            let decision = decide(&facts, restore_prompt, canceller, !case["steering"].is_null(), false);
            let result = &case["result"];
            assert_eq!(json!(decision.restore_text), result["restoreText"], "{name}: restoreText");
            assert_eq!(json!(decision.restored_ids), result["restoredSubmissionIds"], "{name}: restoredSubmissionIds");
            assert_eq!(decision.discard_images, !result["discardPastedImages"].is_null(), "{name}: discardPastedImages");
            assert_eq!(decision.discard_texts, !result["discardPastedTexts"].is_null(), "{name}: discardPastedTexts");
            let reason = match decision.reason {
                Reason::Interrupt => "interrupt",
                Reason::KeepPrompt => "user-cancel-keep-prompt",
                Reason::UserCancel => "user-cancel",
            };
            assert_eq!(json!([reason]), case["abortReasons"], "{name}: abort reason");
            // Another device's cancel hands the text over through `promptRestore`; the record says so in `after`.
            let handed = case["after"]["promptRestore"].as_object().and_then(|restore| restore.get("device")).and_then(Value::as_str);
            assert_eq!(decision.reclaim.and_then(|reclaim| reclaim.handoff).as_deref(), handed, "{name}: promptRestore device");
            replayed += 1;
        }
        assert!(replayed >= 14, "replayed only {replayed} busy cases");
    }

    /// An output commit racing a stop lands on one side of it, never between its read and its record. Both orders over every case Node
    /// recorded: the output first (the recorded case with output: nothing is handed back) or the stop first (the case's stop is the one
    /// Node recorded without the output, and the output that lands after it changes nothing of what was decided).
    #[test]
    fn a_commit_racing_the_stop_lands_on_one_side_of_it() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/phone-chat-core/phone-chat-core.json");
        let recorded: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut both = 0;
        for case in recorded["cases"].as_array().unwrap().iter().filter(|case| case["kind"] == "abort" && case["options"].get("reason").is_none()) {
            let name = case["name"].as_str().unwrap();
            let submit = &case["submit"];
            let output = case["output"]["text"].as_str().is_some_and(|output| !output.trim().is_empty());
            let state = PromptState::new(Facts {
                text: case["prompt"].as_str().unwrap().trim().to_owned(),
                ids: vec![submit["id"].as_str().unwrap().to_owned()],
                device: submit["transcriptMeta"]["device"].as_str().unwrap_or_default().to_owned(),
                restorable: submit["kickoff"] != true,
                committed: false,
                entry: json!({ "options": { "pastedImages": submit["pastedImages"], "pastedTexts": submit["pastedTexts"] } }),
                requeue: None,
                reclaim: None,
            });
            let options = &case["options"];
            let stop = |state: &PromptState| state.decide_and_record(options.get("restorePrompt").and_then(Value::as_bool), options["device"].as_str().unwrap_or_default(), !case["steering"].is_null(), false);
            if output {
                state.commit();
                let decision = stop(&state);
                assert_eq!(json!(decision.restore_text), case["result"]["restoreText"], "{name}: output first");
                assert_eq!(state.snapshot().reclaim, None, "{name}: nothing was handed back after the output");
            } else {
                let decision = stop(&state);
                assert_eq!(json!(decision.restore_text), case["result"]["restoreText"], "{name}: stop first");
                let handed = state.snapshot().reclaim;
                state.commit();
                assert_eq!(state.snapshot().reclaim, handed, "{name}: an output after the stop does not take the hand-back back");
                both += 1;
            }
        }
        assert!(both >= 8, "stop-first replayed only {both} cases");
    }

    /// Two Stops before the turn ended (`abort.mjs:113` twice while busy): the first hands the prompt back, or puts a runtime's
    /// prompt back in the queue, and the second finds nothing left to hand back and takes nothing from the first.
    #[test]
    fn a_second_stop_before_the_turn_ended_keeps_the_first_stops_hand_back() {
        let user = PromptState::new(Facts { text: "p".into(), ids: vec!["s".into()], device: "A".into(), restorable: true, entry: json!({ "options": {} }), ..Facts::default() });
        let runtime = PromptState::new(Facts { text: "k".into(), ids: vec!["r".into()], requeue: Some(json!({ "message": "k" })), entry: json!({ "options": {} }), ..Facts::default() });
        for state in [&user, &runtime] {
            let first = state.decide_and_record(None, "A", false, false);
            assert!(first.reclaim.is_some());
            let second = state.decide_and_record(None, "A", false, false);
            assert_eq!((second.restore_text.as_str(), second.reclaim.as_ref()), ("", None));
            assert_eq!(state.snapshot().reclaim, first.reclaim);
        }
    }
}
