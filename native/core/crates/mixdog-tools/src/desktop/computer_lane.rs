//! The desktop's one keyboard and pointer, shared by every session's helper (`host/command-queue-foreground.ts`,
//! `host/action-sets.ts:35-73`): foreground work runs in it one request at a time, and a request that had to wait
//! behind another is refused when it needs fresh state, since the desktop may have changed meanwhile.

use std::collections::BTreeSet;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Mutex as StdMutex;

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_protocol::ComputerLaneSection;
use serde_json::Map;
use serde_json::Value;
use tokio::sync::Mutex;
use tokio::sync::MutexGuard;
use tokio_util::sync::CancellationToken;

use super::computer_backend::HOST_READ_ACTIONS;

/// The refusal code of a request that waited in the lane (`command-queue-foreground.ts`).
const RECAPTURE_CODE: &str = "computer_foreground_available_recapture_required";
/// `ComputerUseActivityPhase` of the request in the lane.
const ACTIVE_PHASE: &str = "active_foreground";

/// Actions that always take the lane (`computerActionHas(action, 'foreground')`).
const FOREGROUND_ACTIONS: [&str; 12] = [
    "clipboard_read",
    "clipboard_write",
    "focus_window",
    "move_window",
    "window_state",
    "close_window",
    "terminate_process",
    "launch",
    "invoke_menu",
    "fill_saved_login",
    // The two steps a saved-login fill is made of, which the core sends to the helper itself.
    "saved_login_check",
    "saved_login_type",
];
/// Recovery reads that are not host reads (`recovery-reads.ts`); with the host reads they make `observesOnly`.
const RECOVERY_READS: [&str; 1] = ["diagnose"];
/// Semantic actions that keep a window's focus apart from foreground input (`computerActionHas(action, 'focusGuard')`).
const FOCUS_GUARD_ACTIONS: [&str; 3] = ["invoke", "set_value", "toggle"];

/// What a request takes the lane for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A command that sends foreground input and needs a fresh observation after any wait.
    Command,
    /// A command that waits in the lane but addresses its own window or only reads, so waiting does not stale it
    /// (`guardsBackgroundFocus`, `observesOnly`).
    Guarded,
    /// A session's release or the end of its execution, which hand input back.
    Release,
    /// A command that never touches the shared keyboard and pointer; it does not wait.
    Background,
}

/// JavaScript truthiness of an optional field, as `Boolean(step.ref)` and `!step.modifiers` read it.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

fn action_of(step: &Map<String, Value>) -> &str {
    step.get("action").and_then(Value::as_str).unwrap_or("")
}

/// `focusGuarded`: the command, or a step of its sequence, is a focus-guarded action or a ref click without modifiers.
fn focus_guarded(command: &Map<String, Value>) -> bool {
    let guards = |step: &Map<String, Value>| {
        let action = action_of(step);
        FOCUS_GUARD_ACTIONS.contains(&action) || (action == "click" && truthy(step.get("ref")) && !truthy(step.get("modifiers")))
    };
    guards(command)
        || (action_of(command) == "sequence"
            && command.get("steps").and_then(Value::as_array).is_some_and(|steps| steps.iter().filter_map(Value::as_object).any(guards)))
}

/// `observesOnly`: reads and recovery reads observe the desktop; they never send input.
pub(super) fn observes_only(action: &str) -> bool {
    HOST_READ_ACTIONS.contains(&action) || RECOVERY_READS.contains(&action)
}

/// `drivesForeground`: the command, or a step of its sequence, sends foreground input on the person's shared keyboard and
/// pointer (`computerDeliveryMode`).
pub(super) fn drives_foreground(command: &Map<String, Value>) -> bool {
    let foreground = |step: &Map<String, Value>| match step.get("delivery").and_then(Value::as_str) {
        Some("foreground") => true,
        Some("background") => false,
        _ => FOREGROUND_ACTIONS.contains(&action_of(step)),
    };
    foreground(command)
        || (action_of(command) == "sequence"
            && command.get("steps").and_then(Value::as_array).is_some_and(|steps| steps.iter().filter_map(Value::as_object).any(foreground)))
}

impl Kind {
    /// The kind of a tool call's helper command (`requiresForegroundLane`, `guardsBackgroundFocus`, `observesOnly`).
    pub fn of(command: &Map<String, Value>) -> Self {
        let action = action_of(command);
        let foreground_delivery = command.get("delivery").and_then(Value::as_str) == Some("foreground");
        let guarded = focus_guarded(command);
        if !(foreground_delivery || FOREGROUND_ACTIONS.contains(&action) || guarded) {
            return Self::Background;
        }
        if observes_only(action) || (!foreground_delivery && guarded) { Self::Guarded } else { Self::Command }
    }
}

/// The lane of one pool's sessions.
#[derive(Default)]
pub struct Lane {
    turn: Mutex<()>,
    /// Requests in or waiting for the lane (`foregroundQueueDepth`).
    depth: AtomicUsize,
    claims: StdMutex<Claims>,
}

/// The sessions using the desktop, and the windows the sessions that ended before the last one held
/// (`sessionDesktopAnchor`, `handedWindowIds`).
#[derive(Default)]
struct Claims {
    sessions: BTreeSet<String>,
    handed: Vec<String>,
}

/// What a session ending owes the desktop (`restoreSessionDesktop`).
#[derive(Debug, PartialEq, Eq)]
pub struct Leaving {
    /// Whether no other session still uses the desktop, so this one restores the focus.
    pub last: bool,
    /// The windows earlier sessions held, which the last one may take focus from.
    pub handed: Vec<String>,
}

/// Held while a request runs in the lane; leaving it hands the lane to the next request.
/// Fields drop in declaration order: the place is given back before the lane is unlocked, so a request arriving as this one
/// leaves never counts it as ahead (`finally` decrements the depth before the chain moves on, command-queue-foreground.ts).
pub struct Entered<'a> {
    _place: Option<Place<'a>>,
    _turn: Option<MutexGuard<'a, ()>>,
}

/// One request's place in the queue, given back when it leaves or is dropped while waiting.
struct Place<'a>(&'a AtomicUsize);

impl Drop for Place<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Lane {
    /// Waits for the lane, or refuses a request that must capture fresh state after waiting. Cancelling leaves the queue.
    pub async fn enter(&self, kind: Kind, cancel: &CancellationToken) -> Result<Entered<'_>, ComputerError> {
        if kind == Kind::Background {
            return Ok(Entered { _place: None, _turn: None });
        }
        let position = self.depth.fetch_add(1, Ordering::SeqCst);
        let place = Place(&self.depth);
        let turn = tokio::select! {
            turn = self.turn.lock() => turn,
            () = cancel.cancelled() => return Err(ComputerError::Cancelled),
        };
        if kind == Kind::Command && position > 0 {
            drop(place);
            drop(turn);
            return Err(ComputerError::Failed { code: RECAPTURE_CODE.into(), message: format!("{RECAPTURE_CODE}: desktop lane changed; capture fresh state") });
        }
        Ok(Entered { _place: Some(place), _turn: Some(turn) })
    }

    fn claims(&self) -> std::sync::MutexGuard<'_, Claims> {
        self.claims.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A session starts using the desktop.
    pub fn claim(&self, session: &str) {
        self.claims().sessions.insert(session.to_owned());
    }

    /// A session ends: the last one restores the focus from the windows every earlier one held; an earlier one hands its
    /// windows on with `hand_over`, since the desktop is still another session's.
    pub fn leave(&self, session: &str) -> Leaving {
        let mut claims = self.claims();
        claims.sessions.remove(session);
        let last = claims.sessions.is_empty();
        let handed = if last { std::mem::take(&mut claims.handed) } else { Vec::new() };
        Leaving { last, handed }
    }

    /// The windows a session that was not the last held, for the one that is.
    pub fn hand_over(&self, windows: impl IntoIterator<Item = String>) {
        let mut claims = self.claims();
        for window in windows {
            if !claims.handed.contains(&window) {
                claims.handed.push(window);
            }
        }
    }

    /// A session ended without a restore (an abort): it no longer counts, and nothing is left to hand on once none remain.
    pub fn forget(&self, session: &str) {
        let mut claims = self.claims();
        claims.sessions.remove(session);
        if claims.sessions.is_empty() {
            claims.handed.clear();
        }
    }

    /// The lane as the computer section shows it: the requests waiting and the phase of the one running; `None` while free.
    pub fn section(&self) -> Option<ComputerLaneSection> {
        let depth = self.depth.load(Ordering::SeqCst);
        (depth > 0).then(|| ComputerLaneSection { queued: u32::try_from(depth - 1).unwrap_or(u32::MAX), phase: ACTIVE_PHASE.into() })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    fn kind(command: Value) -> Kind {
        Kind::of(command.as_object().unwrap())
    }

    #[test]
    fn classifies_like_the_host() {
        assert_eq!(kind(json!({"action":"click","x":1,"y":2,"delivery":"background"})), Kind::Background);
        assert_eq!(kind(json!({"action":"click","x":1,"y":2,"delivery":"foreground"})), Kind::Command);
        assert_eq!(kind(json!({"action":"focus_window"})), Kind::Command);
        assert_eq!(kind(json!({"action":"clipboard_read"})), Kind::Guarded);
        assert_eq!(kind(json!({"action":"invoke","ref":"e1","delivery":"background"})), Kind::Guarded);
        assert_eq!(kind(json!({"action":"invoke","ref":"e1","delivery":"foreground"})), Kind::Command);
        assert_eq!(kind(json!({"action":"click","ref":"e1","delivery":"background"})), Kind::Guarded);
        assert_eq!(kind(json!({"action":"click","ref":"e1","modifiers":["ctrl"],"delivery":"background"})), Kind::Background);
        assert_eq!(kind(json!({"action":"sequence","delivery":"background","steps":[{"action":"type","text":"a"},{"action":"set_value","ref":"e1"}]})), Kind::Guarded);
        assert_eq!(kind(json!({"action":"sequence","delivery":"background","steps":[{"action":"type","text":"a"}]})), Kind::Background);
        assert_eq!(kind(json!({"action":"capture"})), Kind::Background);
        assert_eq!(kind(json!({"action":"capture","delivery":"foreground"})), Kind::Guarded);
    }

    #[tokio::test]
    async fn a_second_foreground_command_waits_and_is_refused() {
        let lane = Arc::new(Lane::default());
        let cancel = CancellationToken::new();
        let first = lane.enter(Kind::Command, &cancel).await.unwrap();
        assert_eq!(lane.section(), Some(ComputerLaneSection { queued: 0, phase: "active_foreground".into() }));
        let second = {
            let (lane, cancel) = (lane.clone(), cancel.clone());
            tokio::spawn(async move { lane.enter(Kind::Command, &cancel).await.map(drop) })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(lane.section().map(|section| section.queued), Some(1));
        drop(first);
        match second.await.unwrap() {
            Err(ComputerError::Failed { code, message }) => {
                assert_eq!(code, RECAPTURE_CODE);
                assert_eq!(message, "computer_foreground_available_recapture_required: desktop lane changed; capture fresh state");
            }
            other => panic!("expected the recapture refusal, got {other:?}"),
        }
        assert_eq!(lane.section(), None);
    }

    #[tokio::test]
    async fn reads_guarded_and_release_requests_are_not_refused() {
        let lane = Arc::new(Lane::default());
        let cancel = CancellationToken::new();
        let first = lane.enter(Kind::Command, &cancel).await.unwrap();
        // A background command does not wait at all.
        assert!(lane.enter(Kind::Background, &cancel).await.is_ok());
        let waiting: Vec<_> = [Kind::Guarded, Kind::Release]
            .into_iter()
            .map(|kind| {
                let (lane, cancel) = (lane.clone(), cancel.clone());
                tokio::spawn(async move { lane.enter(kind, &cancel).await.map(drop) })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(lane.section().map(|section| section.queued), Some(2));
        drop(first);
        for request in waiting {
            assert!(request.await.unwrap().is_ok());
        }
        assert_eq!(lane.section(), None);
    }

    #[test]
    fn only_the_last_session_restores_and_takes_the_windows_handed_on() {
        let lane = Lane::default();
        lane.claim("a");
        lane.claim("b");
        let first = lane.leave("a");
        assert_eq!(first, Leaving { last: false, handed: Vec::new() });
        lane.hand_over(["hwnd:0x1".to_string(), "hwnd:0x2".to_string()]);
        lane.hand_over(["hwnd:0x2".to_string()]);
        let second = lane.leave("b");
        assert_eq!(second, Leaving { last: true, handed: vec!["hwnd:0x1".into(), "hwnd:0x2".into()] });
        assert_eq!(lane.leave("b"), Leaving { last: true, handed: Vec::new() }, "handed once");
    }

    #[test]
    fn an_aborted_session_hands_nothing_on_and_the_last_one_still_restores() {
        let lane = Lane::default();
        lane.claim("a");
        lane.claim("b");
        lane.forget("a");
        assert_eq!(lane.leave("b"), Leaving { last: true, handed: Vec::new() });
        lane.claim("c");
        lane.claim("d");
        lane.leave("c");
        lane.hand_over(["hwnd:0x9".to_string()]);
        lane.forget("d");
        lane.claim("e");
        assert_eq!(lane.leave("e"), Leaving { last: true, handed: Vec::new() }, "stale windows are dropped with the last claim");
    }

    #[tokio::test]
    async fn a_cancelled_request_leaves_the_queue() {
        let lane = Arc::new(Lane::default());
        let first = lane.enter(Kind::Command, &CancellationToken::new()).await.unwrap();
        let cancel = CancellationToken::new();
        let waiting = {
            let (lane, cancel) = (lane.clone(), cancel.clone());
            tokio::spawn(async move { lane.enter(Kind::Command, &cancel).await.map(drop) })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel.cancel();
        assert!(matches!(waiting.await.unwrap(), Err(ComputerError::Cancelled)));
        assert_eq!(lane.section().map(|section| section.queued), Some(0));
        drop(first);
        assert_eq!(lane.section(), None);
    }
}
