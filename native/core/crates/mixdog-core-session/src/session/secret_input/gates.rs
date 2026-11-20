//! The two locks a secret fill checks before it takes its value (Node `takeover-gate.ts`
//! `assertFree` and `human-only-approval.ts` `beginComputerOperation`), over the takeover state the
//! core already keeps: the open takeover requests of each session's approval book. The book
//! publishes what its open takeover holds to the session's control cell as it changes, and the
//! gates read that.
//!
//! - A session with an open takeover (either surface) refuses its own Browser Use; another
//!   session's takeover never does. A takeover shown in a parent chat is a copy of the agent's own
//!   request and lives in the agent's book only, so it holds the agent alone.
//! - An open screen (`computer`) takeover holds the one screen: Computer Use refuses new
//!   operations for every session meanwhile.
//! - The human-only approvals that are desktop dialogs (a browser approval, the developer-risk
//!   confirm) are holds the desktop declares on the core's one human-only lock
//!   ([`super::HumanOnlyLock`]), which also reads the screen takeovers: the Computer Use gate is
//!   that lock.
//! - A takeover ends when its request resolves; Node's 15-minute expiry is the request's own
//!   `expires_after` (set by whoever raises the card), after which both locks open.

use std::sync::Arc;

use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalId;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

use super::FillGates;
use super::HumanOnlyLock;
use crate::session::SessionDirectory;

/// What a session's open takeover holds.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct TakeoverHold {
    /// The session's own Browser Use is paused.
    pub held: bool,
    /// The screen is held: a `computer` takeover, named by the step it waits on (`takeoverStep`).
    pub screen: Option<String>,
    /// The takeover that names the hold (the oldest) is itself a `computer` one: its hand-over waits for Computer Use to drain,
    /// whatever a later takeover of the session holds (`surface === 'computer'` of the takeover the gate holds).
    pub names_screen: bool,
    /// What the held takeover waits on (`takeoverStep`), of either surface: the Browser Use refusal names it.
    pub step: Option<String>,
    /// The id the held takeover's card shows (`room_approval::card_id` of its request): `takeover/ready` names the takeover it
    /// asks about by the card's id, never by the server request's.
    pub id: Option<String>,
}

/// What the open requests of one session hold: only `handoff_user` takeover cards count, and a
/// takeover whose surface is `computer` holds the screen. The first takeover (by request id) is the one
/// the hold is named and identified by.
pub(crate) fn takeover_hold<'a>(asks: impl Iterator<Item = (ApprovalId, &'a ApprovalAsk)>) -> TakeoverHold {
    let mut hold = TakeoverHold::default();
    // The oldest request names the hold, whatever order the book lists them in.
    let mut asks: Vec<_> = asks.collect();
    asks.sort_by_key(|(id, _)| id.0);
    for (id, ask) in asks {
        if ask.payload.get("kind").and_then(|kind| kind.as_str()) != Some("takeover") {
            continue;
        }
        hold.held = true;
        let takeover = ask.payload.get("takeover");
        let surface = takeover.and_then(|takeover| takeover.get("surface")).and_then(|surface| surface.as_str());
        if hold.step.is_none() {
            hold.step = Some(takeover_step(takeover));
            hold.id = Some(crate::session::room_approval::card_id(&id.0.to_string()));
            hold.names_screen = surface == Some("computer");
        }
        if surface == Some("computer") && hold.screen.is_none() {
            hold.screen = Some(takeover_step(takeover));
        }
    }
    hold
}

/// `takeoverStep` (`takeover-gate.ts`) of a screen takeover: a sign-in's site, else its target, else
/// its instructions, on one line and cut to 160 characters.
fn takeover_step(takeover: Option<&Value>) -> String {
    let field = |key: &str| takeover.and_then(|takeover| takeover.get(key));
    if field("purpose").and_then(Value::as_str) == Some("login")
        && let Some(url) = field("url").and_then(Value::as_str).and_then(|url| url::Url::parse(url).ok())
    {
        return format!("sign-in on {}", url.host_str().unwrap_or_default());
    }
    let text = ["target", "instructions"]
        .into_iter()
        .filter_map(|key| takeover.and_then(|takeover| takeover.get(key)).and_then(Value::as_str))
        .find(|text| !mixdog_js::js_trim(text).is_empty());
    let Some(text) = text else { return "a step only the user can do".to_owned() };
    let step = mixdog_js::js_words(text).collect::<Vec<_>>().join(" ");
    let step = if mixdog_js::utf16_len(&step) > 160 { format!("{}...", mixdog_js::slice_utf16(&step, 157)) } else { step };
    format!("step \"{step}\"")
}

/// Where the gates read the holds of the sessions this process hosts.
pub trait TakeoverHolds: Send + Sync {
    fn hold(&self, thread: &ThreadId) -> TakeoverHold;
    /// The step of a screen takeover some session holds, if any does.
    fn screen(&self) -> Option<String>;
    /// Every session this process hosts whose takeover is open, with its hold (what `takeover/state` publishes). An implementer that
    /// cannot enumerate its sessions reports none.
    fn holding(&self) -> Vec<(ThreadId, TakeoverHold)> {
        Vec::new()
    }
}

impl TakeoverHolds for SessionDirectory {
    fn hold(&self, thread: &ThreadId) -> TakeoverHold {
        self.handle(thread).map(|handle| (**handle.cell.takeover.load()).clone()).unwrap_or_default()
    }

    fn screen(&self) -> Option<String> {
        self.loaded_ids().iter().find_map(|thread| self.hold(thread).screen)
    }

    fn holding(&self) -> Vec<(ThreadId, TakeoverHold)> {
        self.loaded_ids()
            .into_iter()
            .map(|thread| {
                let hold = self.hold(&thread);
                (thread, hold)
            })
            .filter(|(_, hold)| hold.held)
            .collect()
    }
}

/// [`FillGates`] over the sessions' takeover holds and the one human-only lock.
pub struct TakeoverGates {
    holds: Arc<dyn TakeoverHolds>,
    lock: Arc<HumanOnlyLock>,
}

impl TakeoverGates {
    pub fn new(holds: Arc<dyn TakeoverHolds>, lock: Arc<HumanOnlyLock>) -> Self {
        Self { holds, lock }
    }
}

impl FillGates for TakeoverGates {
    fn browser_free(&self, thread: &ThreadId) -> bool {
        !self.holds.hold(thread).held
    }

    fn computer_free(&self) -> bool {
        self.lock.refusal().is_none()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use mixdog_core_api::CallContext;
    use mixdog_core_api::domain::approval::ApprovalKind;
    use serde_json::json;

    use super::*;
    use crate::session::room_approval::card_id;

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
            self.0.lock().unwrap().get(thread.as_str()).cloned().unwrap_or_default()
        }
        fn screen(&self) -> Option<String> {
            self.0.lock().unwrap().values().find_map(|hold| hold.screen.clone())
        }
        fn holding(&self) -> Vec<(ThreadId, TakeoverHold)> {
            self.0.lock().unwrap().iter().map(|(session, hold)| (ThreadId::from(session.as_str()), hold.clone())).collect()
        }
    }

    #[test]
    fn only_a_takeover_request_holds_and_only_a_screen_takeover_holds_the_screen() {
        let secret = ask(json!({ "kind": "secret", "secret": { "surface": "computer" } }));
        let command = ask(json!({ "command": "ls" }));
        assert_eq!(takeover_hold([(ApprovalId(1), &secret), (ApprovalId(2), &command)].into_iter()), TakeoverHold::default());
        let step = Some("a step only the user can do".to_owned());
        assert_eq!(
            takeover_hold([(ApprovalId(1), &secret), (ApprovalId(7), &takeover("browser"))].into_iter()),
            TakeoverHold { held: true, screen: None, names_screen: false, step: step.clone(), id: Some(card_id("7")) }
        );
        // The oldest takeover names the hold, whatever order the book lists them in.
        assert_eq!(
            takeover_hold([(ApprovalId(9), &takeover("computer")), (ApprovalId(4), &takeover("browser"))].into_iter()),
            TakeoverHold { held: true, screen: step.clone(), names_screen: false, step, id: Some(card_id("4")) }
        );
        // The same takeovers with the screen one oldest: the hold is named by it.
        let oldest = takeover_hold([(ApprovalId(2), &takeover("computer")), (ApprovalId(5), &takeover("browser"))].into_iter());
        assert!(oldest.names_screen && oldest.screen.is_some());
        assert_eq!(takeover_hold(std::iter::empty()), TakeoverHold::default());
    }

    /// A browser takeover is named by its step too: the Browser Use refusal says what the person was asked to do.
    #[test]
    fn a_browser_takeover_is_named_by_its_step() {
        let card = ask(json!({ "kind": "takeover", "takeover": { "surface": "browser", "target": "the captcha" } }));
        let hold = takeover_hold(std::iter::once((ApprovalId(3), &card)));
        assert_eq!((hold.screen, hold.step.as_deref(), hold.id), (None, Some("step \"the captcha\""), Some(card_id("3"))));
    }

    /// The hold is named by the id the takeover card shows (the card's `takeover/ready` asks with it), not by the server
    /// request's id: a hold named by the request id is never the one the card asks about, so its "Done" never becomes choosable.
    #[test]
    fn a_takeover_hold_is_named_by_the_id_its_card_shows() {
        let card = ask(json!({ "kind": "takeover", "takeover": { "surface": "browser", "target": "x" } }));
        let hold = takeover_hold(std::iter::once((ApprovalId(12), &card)));
        // The card a client shows carries `card_id` of the request (actor.rs `params["card"]["id"]`).
        assert_eq!(hold.id, Some(card_id(&ApprovalId(12).0.to_string())));
        assert_ne!(hold.id.as_deref(), Some("12"));
    }

    /// A screen takeover is named as `takeoverStep` names it: a sign-in's site, else its target, else its
    /// instructions, on one line and cut to 160 characters.
    #[test]
    fn a_screen_takeover_is_named_by_its_step() {
        let step = |takeover: Value| takeover_hold(std::iter::once((ApprovalId(1), &ask(json!({ "kind": "takeover", "takeover": takeover }))))).screen;
        let named = |text: &str| Some(format!("step \"{text}\""));
        assert_eq!(step(json!({ "surface": "computer", "target": " \n ", "instructions": "  Confirm\n the\tdialog " })), named("Confirm the dialog"));
        assert_eq!(step(json!({ "surface": "computer", "target": "the dialog", "instructions": "x" })), named("the dialog"));
        assert_eq!(step(json!({ "surface": "computer", "target": "a".repeat(200) })), named(&format!("{}...", "a".repeat(157))));
        assert_eq!(step(json!({ "surface": "computer", "target": "a".repeat(160) })), named(&"a".repeat(160)));
        assert_eq!(step(json!({ "surface": "computer", "target": 7 })), Some("a step only the user can do".to_owned()));
        assert_eq!(step(json!({ "surface": "browser", "target": "x" })), None);
        assert_eq!(
            step(json!({ "surface": "computer", "purpose": "login", "url": "https://Accounts.Example.com:8443/x", "target": "t" })),
            Some("sign-in on accounts.example.com".to_owned())
        );
        assert_eq!(step(json!({ "surface": "computer", "purpose": "login", "url": "not a url", "target": "t" })), named("t"));
    }

    /// What the two locks say with the given takeover holds open and the desktop's holds on the human-only lock.
    fn locks(holds: &[(&str, TakeoverHold)], desktop_holds: usize, sessions: &[&str]) -> (Vec<bool>, bool) {
        let table = Arc::new(Holds(Mutex::new(holds.iter().map(|(session, hold)| ((*session).to_owned(), hold.clone())).collect())));
        let lock = Arc::new(HumanOnlyLock::new(table.clone()));
        let desktop = CallContext::internal("desktop");
        let _held: Vec<_> = (0..desktop_holds).map(|_| lock.hold("", &desktop)).collect();
        let gates = TakeoverGates::new(table, lock);
        (sessions.iter().map(|session| gates.browser_free(&ThreadId::from(*session))).collect(), gates.computer_free())
    }

    /// A session with an open takeover (either surface) refuses its own Browser Use and no other session's; only a screen takeover
    /// (or a desktop dialog's hold on the human-only lock) refuses Computer Use, for every session.
    #[test]
    fn a_takeover_holds_its_own_browser_and_only_a_screen_or_dialog_hold_holds_the_screen() {
        let browser = takeover_hold(std::iter::once((ApprovalId(1), &takeover("browser"))));
        let screen = takeover_hold(std::iter::once((ApprovalId(1), &takeover("computer"))));
        assert_eq!(locks(&[], 0, &["A", "B"]), (vec![true, true], true), "nothing open: both are free");
        assert_eq!(locks(&[("A", browser)], 0, &["A", "B"]), (vec![false, true], true), "a browser takeover pauses its own session's browser only");
        assert_eq!(locks(&[("A", screen)], 0, &["A", "B"]), (vec![false, true], false), "a screen takeover also holds the screen for everyone");
        assert_eq!(locks(&[], 1, &["A", "B"]), (vec![true, true], false), "a desktop dialog holds the screen, not a browser");
        assert_eq!(locks(&[], 0, &["A", "B"]).1, true, "released: the screen is free again");
    }

    /// A takeover nobody finishes ends with its request's own expiry: held until the resolution is durable, then both locks open.
    #[test]
    fn a_takeover_nobody_finishes_frees_the_session_and_the_screen_at_its_expiry() {
        use mixdog_core_api::domain::approval::ApprovalId;
        use mixdog_core_api::ids::TurnId;
        use mixdog_core_base::approvals::ApprovalBook;
        use mixdog_core_base::approvals::Lineage;
        use mixdog_protocol::ApprovalResolution;
        use std::time::Duration;
        use tokio::time::Instant;

        let expiry = Duration::from_secs(15 * 60);
        let wait = Duration::from_secs(16 * 60);
        let thread = ThreadId::from("T");
        let mut card = takeover("computer");
        card.expires_after = Some(expiry);
        let aid = ApprovalId(1);
        let mut book = ApprovalBook::default();
        book.insert(ApprovalBook::request(aid, &thread, &Lineage::top_level(&thread), card, 0), TurnId::from("r1".to_owned()), None);
        let state = |book: &ApprovalBook| {
            let holds = Arc::new(Holds(Mutex::new(HashMap::from([("T".to_owned(), takeover_hold(book.open_requests()))]))));
            let gates = TakeoverGates::new(holds.clone(), Arc::new(HumanOnlyLock::new(holds)));
            (gates.browser_free(&thread), gates.computer_free())
        };
        assert_eq!(state(&book), (false, false));
        assert!(book.expired(Instant::now()).is_empty(), "not before its deadline");
        let due = book.expired(Instant::now() + wait);
        assert_eq!(due.len(), 1);
        assert_eq!(state(&book), (false, false), "held until the resolution is durable");
        book.resolved(aid, &ApprovalResolution::TimedOut { at: 1 });
        assert_eq!(state(&book), (true, true));
    }
}
