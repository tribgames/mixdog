//! The transient `/btw` side-question panel (`app/btw-controller.mjs` and `app/use-btw-panel.mjs`).
//!
//! The answer lives only in this panel (never the transcript). [`BtwController::ask`] replaces any existing panel,
//! [`BtwController::close`] (Esc) cancels a pending request, and a result that arrives after a replace, a close or a session
//! change is ignored through the request sequence. The panel state is the controller's own ([`BtwController::panel`]); the row
//! arithmetic of the panel (`btwPanelRows`, `btwContentRows`, `btwScrollMax`, `btwScrollOffset`) is
//! `surface::layout::btw_panel_rows` and `mixdog_tui_widgets::panels::btw_panel`, and the usage hint is
//! [`crate::slash::BTW_USAGE_HINT`].
//!
//! Each request is bound to the session it was asked in. A settlement whose session no longer matches is ignored; [`sync`]
//! (a session change: new, resume, clear, switch) and [`dispose`] (unmount) cancel a pending request for its originating
//! session. The asynchronous steps of the Node code are ordered events: [`ask`] answers the request, the run loop then calls
//! [`dispatch`] (the microtask that follows the ask), sends the side question when it says so, and gives the answer to
//! [`settle`].
//!
//! [`ask`]: BtwController::ask
//! [`dispatch`]: BtwController::dispatch
//! [`settle`]: BtwController::settle
//! [`sync`]: BtwController::sync
//! [`dispose`]: BtwController::dispose

use serde_json::{Value, json};

/// What the controller needs of the application.
pub trait BtwHost {
    /// The id of the session the application is in now (`sessionIdRef.current`, empty for none).
    fn session_id(&self) -> String;
    /// `store.cancelSide?.(sessionId)`: best-effort, an error or a missing method is not reported.
    fn cancel_side(&mut self, session_id: &str);
}

/// The request a question made: what [`BtwController::dispatch`] and [`BtwController::settle`] are given back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BtwAsk {
    id: u64,
    session_id: String,
    /// The question, to hand to `store.askSide(question)`.
    pub question: String,
}

/// A request queued or in flight (`pending`).
#[derive(Clone, Debug)]
struct Pending {
    id: u64,
    session_id: String,
    dispatched: bool,
}

/// The controller of the panel (`createBtwController` and the state of `useBtwPanel`).
#[derive(Debug, Default)]
pub struct BtwController {
    seq: u64,
    pending: Option<Pending>,
    /// The session the visible panel was asked in.
    origin: Option<String>,
    /// `{ question, status: 'pending' | 'done' | 'error', text }`.
    panel: Option<Value>,
}

/// `String(value ?? '')`.
fn text_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::value_to_string(value),
    }
}

fn panel_value(question: &str, status: &str, text: &str) -> Value {
    json!({ "question": question, "status": status, "text": text })
}

impl BtwController {
    pub fn new() -> Self {
        Self::default()
    }

    /// The panel on screen.
    pub fn panel(&self) -> Option<&Value> {
        self.panel.as_ref()
    }

    fn cancel_pending(&mut self, host: &mut dyn BtwHost) {
        let Some(Pending { session_id, dispatched, .. }) = self.pending.take() else { return };
        // Not dispatched yet: dropping `pending` stops the queued request, so there is nothing to cancel (a cancel sent
        // first would not hit it).
        if dispatched {
            host.cancel_side(&session_id);
        }
    }

    /// `ask(question)`: replaces any panel with a pending one bound to the current session.
    pub fn ask(&mut self, host: &mut dyn BtwHost, question: &str) -> BtwAsk {
        self.cancel_pending(host);
        self.seq += 1;
        let id = self.seq;
        let session_id = host.session_id();
        self.pending = Some(Pending { id, session_id: session_id.clone(), dispatched: false });
        self.origin = Some(session_id.clone());
        self.panel = Some(panel_value(question, "pending", ""));
        BtwAsk { id, session_id, question: question.to_owned() }
    }

    /// The step after the ask: whether the question is to be sent now. `askSide` runs against the store's current session, so
    /// it is sent only while this ask is still live and still in its origin session. A dropped ask is never sent; the run loop
    /// gives [`settle`](Self::settle) a null answer for it, which the guard there ignores while the ask is stale.
    pub fn dispatch(&mut self, host: &dyn BtwHost, ask: &BtwAsk) -> bool {
        let live = self.pending.as_ref().is_some_and(|pending| pending.id == ask.id);
        if !live || ask.id != self.seq || host.session_id() != ask.session_id {
            if live {
                self.pending = None;
            }
            return false;
        }
        if let Some(pending) = self.pending.as_mut() {
            pending.dispatched = true;
        }
        true
    }

    /// The answer of `askSide` (`Ok`, a result with a `text`) or its failure (`Err`, the message), for `ask`. Ignored when the
    /// ask is no longer the current one or the session changed.
    pub fn settle(&mut self, host: &dyn BtwHost, ask: &BtwAsk, result: Result<Value, String>) {
        if ask.id != self.seq || host.session_id() != ask.session_id {
            return;
        }
        self.pending = None;
        self.panel = Some(match result {
            Ok(answer) => panel_value(&ask.question, "done", &text_nullish(answer.get("text"))),
            Err(error) if error.is_empty() => panel_value(&ask.question, "error", "side question failed"),
            Err(error) => panel_value(&ask.question, "error", &error),
        });
    }

    /// `close()` (Esc): cancels a pending request and clears the panel.
    pub fn close(&mut self, host: &mut dyn BtwHost) {
        self.cancel_pending(host);
        self.seq += 1;
        self.origin = None;
        self.panel = None;
    }

    /// The session changed: a panel from another conversation is cancelled and cleared.
    pub fn sync(&mut self, host: &mut dyn BtwHost) {
        let changed = self.origin.as_ref().is_some_and(|origin| host.session_id() != *origin);
        if changed {
            self.close(host);
        }
    }

    /// Unmount: cancels a pending request without touching the panel.
    pub fn dispose(&mut self, host: &mut dyn BtwHost) {
        self.cancel_pending(host);
        self.seq += 1;
        self.origin = None;
    }
}
