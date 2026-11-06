//! The two locks a secret fill checks before it takes its value (Node `takeover-gate.ts`
//! `assertFree` and `human-only-approval.ts` `beginComputerOperation`), over the takeover state the
//! core already keeps: the open takeover requests of each session's approval book. There is no
//! second lock; the book publishes what its open takeover holds to the session's control cell as
//! it changes, and the gates read that.
//!
//! - A session with an open takeover (either surface) refuses its own Browser Use; another
//!   session's takeover never does. A takeover shown in a parent chat is a copy of the agent's own
//!   request and lives in the agent's book only, so it holds the agent alone.
//! - An open screen (`computer`) takeover holds the one screen: Computer Use refuses new
//!   operations for every session meanwhile.
//! - The human-only approvals that are desktop dialogs (a browser approval, the developer-risk
//!   confirm) are not core state; the desktop makes the same check itself when a computer command
//!   reaches it (`command-attempt.ts` `beginComputerOperation`).
//! - A takeover ends when its request resolves; Node's 15-minute expiry is the request's own
//!   `expires_after` (set by whoever raises the card), after which both locks open.

use std::sync::Arc;

use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::ids::ThreadId;

use super::FillGates;
use crate::session::SessionDirectory;

/// What a session's open takeover holds.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct TakeoverHold {
    /// The session's own Browser Use is paused.
    pub held: bool,
    /// The screen is held: a `computer` takeover.
    pub screen: bool,
}

/// What the open requests of one session hold: only `handoff_user` takeover cards count, and a
/// takeover whose surface is `computer` holds the screen.
pub(crate) fn takeover_hold<'a>(asks: impl Iterator<Item = &'a ApprovalAsk>) -> TakeoverHold {
    let mut hold = TakeoverHold::default();
    for ask in asks {
        if ask.payload.get("kind").and_then(|kind| kind.as_str()) != Some("takeover") {
            continue;
        }
        hold.held = true;
        let surface = ask.payload.get("takeover").and_then(|takeover| takeover.get("surface")).and_then(|surface| surface.as_str());
        hold.screen |= surface == Some("computer");
    }
    hold
}

/// Where the gates read the holds of the sessions this process hosts.
pub trait TakeoverHolds: Send + Sync {
    fn hold(&self, thread: &ThreadId) -> TakeoverHold;
    /// Whether any session's takeover holds the screen.
    fn any_screen(&self) -> bool;
}

impl TakeoverHolds for SessionDirectory {
    fn hold(&self, thread: &ThreadId) -> TakeoverHold {
        self.handle(thread).map(|handle| **handle.cell.takeover.load()).unwrap_or_default()
    }

    fn any_screen(&self) -> bool {
        self.loaded_ids().iter().any(|thread| self.hold(thread).screen)
    }
}

/// [`FillGates`] over the sessions' takeover holds.
pub struct TakeoverGates {
    holds: Arc<dyn TakeoverHolds>,
}

impl TakeoverGates {
    pub fn new(holds: Arc<dyn TakeoverHolds>) -> Self {
        Self { holds }
    }
}

impl FillGates for TakeoverGates {
    fn browser_free(&self, thread: &ThreadId) -> bool {
        !self.holds.hold(thread).held
    }

    fn computer_free(&self) -> bool {
        !self.holds.any_screen()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use mixdog_core_api::domain::approval::ApprovalKind;
    use serde_json::Value;
    use serde_json::json;

    use super::*;

    /// Recorded from the real `createTakeoverGate` over `withHumanOnlyApproval`
    /// (`benchmarks/rust-core/recorders/record-secret-gates.mjs`).
    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../../fixtures/secret-gates/gates.json")).unwrap()
    }

    fn ask(payload: Value) -> ApprovalAsk {
        ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: None,
            tool: Some("handoff_user".to_owned()),
            action_kind: None,
            reason: None,
            payload,
            remember: Vec::new(),
            expires_after: None,
        }
    }

    fn takeover(surface: &str) -> ApprovalAsk {
        ask(json!({ "kind": "takeover", "takeover": { "surface": surface } }))
    }

    #[derive(Default)]
    struct Holds(Mutex<HashMap<String, TakeoverHold>>);

    impl TakeoverHolds for Holds {
        fn hold(&self, thread: &ThreadId) -> TakeoverHold {
            self.0.lock().unwrap().get(thread.as_str()).copied().unwrap_or_default()
        }
        fn any_screen(&self) -> bool {
            self.0.lock().unwrap().values().any(|hold| hold.screen)
        }
    }

    #[test]
    fn the_gates_follow_the_recorded_takeover_scenarios() {
        let doc = golden();
        let sessions = doc["sessions"].as_array().unwrap();
        let mut replayed = 0;
        for case in doc["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let steps = case["steps"].as_array().unwrap();
            // A desktop dialog's human-only approval and a takeover's expiry are not core takeover state.
            if steps.iter().any(|step| matches!(step["do"].as_str(), Some("browserApproval" | "answerBrowserApproval" | "wait"))) {
                continue;
            }
            replayed += 1;
            let holds = Arc::new(Holds::default());
            let gates = TakeoverGates::new(holds.clone());
            let mut observed = case["observed"].as_array().unwrap().iter();
            for step in steps {
                let thread = step["thread"].as_str().unwrap_or_default().to_owned();
                match step["do"].as_str().unwrap() {
                    // A copy shown in a parent chat is not in the parent's own book: `copyTo` adds nothing.
                    "takeover" => {
                        let hold = takeover_hold(std::iter::once(&takeover(step["surface"].as_str().unwrap())));
                        holds.0.lock().unwrap().insert(thread, hold);
                    }
                    "resolve" => {
                        holds.0.lock().unwrap().remove(&thread);
                    }
                    "observe" => {
                        let want = observed.next().unwrap();
                        for session in sessions {
                            let session = session.as_str().unwrap();
                            assert_eq!(gates.browser_free(&ThreadId::from(session)), want["browserFree"][session] == json!(true), "{name} {session}");
                        }
                        assert_eq!(gates.computer_free(), want["computerFree"] == json!(true), "{name}");
                    }
                    other => panic!("{other}"),
                }
            }
            assert!(observed.next().is_none(), "{name}");
        }
        assert_eq!(replayed, 7);
    }

    #[test]
    fn only_a_takeover_request_holds_and_only_a_screen_takeover_holds_the_screen() {
        let secret = ask(json!({ "kind": "secret", "secret": { "surface": "computer" } }));
        let command = ask(json!({ "command": "ls" }));
        assert_eq!(takeover_hold([&secret, &command].into_iter()), TakeoverHold::default());
        assert_eq!(takeover_hold([&secret, &takeover("browser")].into_iter()), TakeoverHold { held: true, screen: false });
        assert_eq!(takeover_hold([&takeover("browser"), &takeover("computer")].into_iter()), TakeoverHold { held: true, screen: true });
        assert_eq!(takeover_hold(std::iter::empty()), TakeoverHold::default());
    }

    /// The recorded expiry scenario ("a takeover nobody finishes frees the session and the screen at
    /// its expiry"): the takeover card carries the recorded expiry as its `expires_after`, the
    /// approval book resolves it when that passes, and both locks open once the resolution is durable.
    #[test]
    fn a_takeover_nobody_finishes_frees_the_session_and_the_screen_at_its_expiry() {
        use mixdog_core_api::domain::approval::ApprovalId;
        use mixdog_core_api::ids::TurnId;
        use mixdog_core_base::approvals::ApprovalBook;
        use mixdog_core_base::approvals::Lineage;
        use mixdog_protocol::ApprovalResolution;
        use std::time::Duration;
        use tokio::time::Instant;

        let doc = golden();
        let case = doc["cases"].as_array().unwrap().iter().find(|c| c["name"] == "a takeover nobody finishes frees the session and the screen at its expiry").unwrap();
        let expiry = Duration::from_millis(case["expiryMs"].as_u64().unwrap());
        let wait = Duration::from_millis(case["steps"].as_array().unwrap().iter().find(|s| s["do"] == "wait").unwrap()["ms"].as_u64().unwrap());
        assert!(wait > expiry);
        let thread = ThreadId::from("T");
        let mut card = takeover("computer");
        card.expires_after = Some(expiry);
        let aid = ApprovalId(1);
        let mut book = ApprovalBook::default();
        book.insert(ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), card, 0), TurnId::from("r1".to_owned()), None);
        let observed = case["observed"].as_array().unwrap();
        let state = |book: &ApprovalBook| {
            let gates = TakeoverGates::new(Arc::new(Holds(Mutex::new(HashMap::from([("T".to_owned(), takeover_hold(book.open_asks()))])))));
            (gates.browser_free(&thread), gates.computer_free())
        };
        let want = |at: usize| (observed[at]["browserFree"]["T"] == json!(true), observed[at]["computerFree"] == json!(true));
        assert_eq!(state(&book), want(0));
        assert!(book.expired(Instant::now()).is_empty(), "not before its deadline");
        let due = book.expired(Instant::now() + wait);
        assert_eq!(due.len(), 1);
        // Held until the resolution is durable, as the book keeps the request until then.
        assert_eq!(state(&book), want(0));
        book.resolved(aid, &ApprovalResolution::TimedOut { at: 1 });
        assert_eq!(state(&book), want(1));
    }
}