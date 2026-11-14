//! The helper's pointer-progress lines relayed to the desktop's overlay (`backend/host-worker-process.ts:73-76`).
//!
//! The overlay is Electron's: it draws the agent's arrow and, while it does, the helper hides the real pointer. So the core asks
//! for progress only when a desktop that serves Computer can draw it, and carries each line there as `host/computer/pointerFeedback`.

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::ids::Method;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

/// The prefix of a helper's pointer line (`native/mixdog-computer/src/protocol.rs` `POINTER_MARKER`).
pub(super) const LINE_MARKER: &str = "@@MIXDOG_POINTER@@";
const METHOD: &str = "host/computer/pointerFeedback";
/// The desktop answers `null` at once; an event it leaves longer than this is lost rather than holding the ones behind it.
const SEND_TIMEOUT: Duration = Duration::from_millis(2000);
/// The most events one request carries.
const BATCH: usize = 64;

/// Actions whose helper streams pointer progress while they run (`worker-pool.ts` `POINTER_FEEDBACK_ACTIONS`).
const POINTER_ACTIONS: [&str; 17] = [
    "click",
    "invoke",
    "set_value",
    "toggle",
    "double_click",
    "right_click",
    "middle_click",
    "triple_click",
    "mouse_down",
    "mouse_up",
    "mouse_move",
    "drag",
    "scroll",
    "key",
    "key_down",
    "key_up",
    "type",
];

/// Progress phases an event may claim; anything else is not a phase the overlay paints (`POINTER_PROGRESS_PHASES`).
const PHASES: [&str; 7] = ["move", "prepare", "press", "release", "drag", "scroll", "type"];

/// Whether the overlay can draw the agent's arrow: the desktop serves Computer, whose Electron process owns the overlay and
/// shows it for every session that is driving the desktop (`publishPointerProgress`). Without one the helper must neither
/// stream progress nor hide the real pointer.
pub(super) fn wants_feedback(desktop: Option<&Arc<dyn HostChannel>>) -> bool {
    desktop.is_some_and(|desktop| desktop.serves(HostCapability::Computer))
}

/// Asks the helper for pointer progress on a pointer action (a sequence step is read through its envelope) when the overlay can
/// draw it (`worker-pool.ts` `callPowerShell`: `pointerAction && onPointerProgress`). The answer always replaces what the request
/// carried, as there: the helper hides the real pointer on it, so no caller may ask for that without an overlay to draw the arrow.
pub(super) fn decorate(command: &mut Map<String, Value>, desktop: Option<&Arc<dyn HostChannel>>) {
    if asks(command, desktop) {
        command.insert("pointer_feedback".into(), Value::Bool(true));
    } else {
        command.remove("pointer_feedback");
    }
}

/// The macOS / Linux line as Node wrote it: `pointer_feedback` is always present, `pointerAction && onPointerProgress`
/// (`worker-pool.ts` `callPowerShell`), so a read carries `false` as the recorded Linux sessions do.
pub(super) fn mark(command: &mut Map<String, Value>, desktop: Option<&Arc<dyn HostChannel>>) {
    let asked = asks(command, desktop);
    command.insert("pointer_feedback".into(), Value::Bool(asked));
}

/// Whether the request is a pointer action (a sequence step read through its envelope) the overlay can draw.
fn asks(command: &Map<String, Value>, desktop: Option<&Arc<dyn HostChannel>>) -> bool {
    let action = match command.get("action").and_then(Value::as_str) {
        Some("sequence_step") => command.get("step").and_then(|step| step.get("action")).and_then(Value::as_str),
        other => other,
    };
    action.is_some_and(|action| POINTER_ACTIONS.contains(&action)) && wants_feedback(desktop)
}

/// One pointer event as the overlay takes it, or None for a line that is not one the helper writes (`reportPointerProgress`):
/// finite coordinates, a boolean `held` and a known phase, which is a move or a drag by `held` when the line names none.
fn event(body: &str) -> Option<Value> {
    let line: Value = serde_json::from_str(body).ok()?;
    let finite = |key: &str| line.get(key).filter(|value| value.as_f64().is_some_and(f64::is_finite)).cloned();
    let held = line.get("held")?.as_bool()?;
    let phase = match line.get("phase") {
        None | Some(Value::Null) => if held { "drag" } else { "move" },
        Some(phase) => phase.as_str().filter(|phase| PHASES.contains(phase))?,
    };
    let mode = if line.get("mode").and_then(Value::as_str) == Some("foreground") { "foreground" } else { "background" };
    let mut event = json!({"x": finite("x")?, "y": finite("y")?, "held": held, "phase": phase, "mode": mode});
    if let Some(window) = line.get("window_id").and_then(Value::as_str).filter(|window| !window.is_empty()) {
        event["windowId"] = json!(window);
    }
    Some(event)
}

/// One helper's pointer relay. The events leave in the order the helper wrote them, from one task.
pub(super) struct Pointer {
    desktop: Option<Arc<dyn HostChannel>>,
    /// None where there is no runtime to run the relay on: the events are dropped.
    inbox: Option<mpsc::UnboundedSender<Value>>,
}

impl Pointer {
    /// The relay of `session`'s helper to `desktop`'s overlay.
    pub(super) fn new(desktop: Option<Arc<dyn HostChannel>>, session: &str) -> Self {
        let inbox = desktop.clone().zip(tokio::runtime::Handle::try_current().ok()).map(|(desktop, runtime)| {
            let (send, receive) = mpsc::unbounded_channel();
            runtime.spawn(serve(receive, desktop, session.to_owned()));
            send
        });
        Self { desktop, inbox }
    }

    /// One pointer line, without its prefix. A line that is not a pointer event, or one nobody can draw, is dropped without a word:
    /// the overlay is never a failure of the request.
    pub(super) fn on_line(&self, body: &str) {
        if !wants_feedback(self.desktop.as_ref()) {
            return;
        }
        if let (Some(event), Some(inbox)) = (event(body), &self.inbox) {
            let _ = inbox.send(event);
        }
    }
}

/// Carries the events to the desktop, those that queued up while one request was out together.
async fn serve(mut inbox: mpsc::UnboundedReceiver<Value>, desktop: Arc<dyn HostChannel>, session: String) {
    while let Some(first) = inbox.recv().await {
        let mut events = vec![first];
        while events.len() < BATCH && let Ok(next) = inbox.try_recv() {
            events.push(next);
        }
        let params = json!({"sessionId": session, "events": events});
        let _ = mixdog_rt::time::timeout(SEND_TIMEOUT, desktop.request(HostCapability::Computer, Method(METHOD), params)).await;
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mixdog_core_api::CoreError;
    use mixdog_core_api::HostError;

    use super::*;

    /// A desktop that keeps what it is asked.
    struct Desktop {
        serving: bool,
        asked: mpsc::UnboundedSender<Value>,
    }

    #[async_trait]
    impl HostChannel for Desktop {
        fn serves(&self, capability: HostCapability) -> bool {
            assert_eq!(capability, HostCapability::Computer);
            self.serving
        }
        async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            assert_eq!((capability, method.0), (HostCapability::Computer, METHOD));
            let _ = self.asked.send(params);
            Ok(Value::Null)
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    fn desktop(serving: bool) -> (Arc<dyn HostChannel>, mpsc::UnboundedReceiver<Value>) {
        let (asked, receive) = mpsc::unbounded_channel();
        let desktop: Arc<dyn HostChannel> = Arc::new(Desktop { serving, asked });
        (desktop, receive)
    }

    async fn next(channel: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        mixdog_rt::time::timeout(Duration::from_secs(5), channel.recv()).await.expect("in time").expect("sent")
    }

    fn command(action: &str) -> Map<String, Value> {
        json!({"action": action}).as_object().cloned().unwrap()
    }

    #[test]
    fn pointer_feedback_is_asked_for_only_while_a_desktop_serving_computer_can_draw_it() {
        let (serving, _) = desktop(true);
        let (absent, _) = desktop(false);
        for action in ["click", "drag", "key", "type", "scroll", "invoke"] {
            let mut asked = command(action);
            decorate(&mut asked, Some(&serving));
            assert_eq!(asked.get("pointer_feedback"), Some(&json!(true)), "{action}");
            for none in [Some(&absent), None] {
                let mut refused = command(action);
                decorate(&mut refused, none);
                assert_eq!(refused.get("pointer_feedback"), None, "{action}");
            }
        }
        for action in ["snapshot", "list_windows", "release_session", "focus_window", "wait"] {
            let mut read = command(action);
            decorate(&mut read, Some(&serving));
            assert_eq!(read.get("pointer_feedback"), None, "{action}");
        }
    }

    #[test]
    fn a_sequence_step_is_read_through_its_envelope_and_the_request_never_decides() {
        let (serving, _) = desktop(true);
        let mut step = json!({"action": "sequence_step", "step": {"action": "click"}}).as_object().cloned().unwrap();
        decorate(&mut step, Some(&serving));
        assert_eq!(step.get("pointer_feedback"), Some(&json!(true)));
        let mut wait = json!({"action": "sequence_step", "step": {"action": "wait"}}).as_object().cloned().unwrap();
        decorate(&mut wait, Some(&serving));
        assert_eq!(wait.get("pointer_feedback"), None);
        // A request that asks on its own is answered as any other: never a hidden pointer without an overlay.
        let (absent, _) = desktop(false);
        for (action, desktop, expected) in [("click", None, None), ("click", Some(&absent), None), ("snapshot", Some(&serving), None), ("click", Some(&serving), Some(json!(true)))] {
            let mut asked = json!({"action": action, "pointer_feedback": true}).as_object().cloned().unwrap();
            decorate(&mut asked, desktop);
            assert_eq!(asked.get("pointer_feedback"), expected.as_ref(), "{action}");
        }
    }

    #[test]
    fn a_macos_or_linux_line_always_says_whether_it_asks() {
        let (serving, _) = desktop(true);
        let (absent, _) = desktop(false);
        for (action, desktop, expected) in [("click", Some(&serving), true), ("click", Some(&absent), false), ("click", None, false), ("list_windows", Some(&serving), false)] {
            let mut asked = json!({"action": action, "pointer_feedback": !expected}).as_object().cloned().unwrap();
            mark(&mut asked, desktop);
            assert_eq!(asked.get("pointer_feedback"), Some(&json!(expected)), "{action}");
        }
    }

    #[test]
    fn a_line_is_an_event_only_with_finite_coordinates_a_flag_and_a_known_phase() {
        assert_eq!(
            event(r#"{"id":4,"x":90,"y":12.5,"held":true,"phase":"press","mode":"foreground","window_id":"hwnd:0x3"}"#),
            Some(json!({"x": 90, "y": 12.5, "held": true, "phase": "press", "mode": "foreground", "windowId": "hwnd:0x3"}))
        );
        // A line with no phase is a move, or a drag while held; no mode is background; no window names none.
        assert_eq!(event(r#"{"x":1,"y":2,"held":false}"#), Some(json!({"x": 1, "y": 2, "held": false, "phase": "move", "mode": "background"})));
        assert_eq!(event(r#"{"x":1,"y":2,"held":true,"phase":null,"window_id":""}"#).unwrap()["phase"], "drag");
        for bad in [
            "",
            "not json",
            r#"{"x":1,"y":2}"#,
            r#"{"x":1,"y":2,"held":"yes"}"#,
            r#"{"x":"1","y":2,"held":false}"#,
            r#"{"y":2,"held":false}"#,
            r#"{"x":1,"y":2,"held":false,"phase":"teleport"}"#,
            r#"{"x":1,"y":2,"held":false,"phase":7}"#,
        ] {
            assert_eq!(event(bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn events_reach_the_desktop_in_order_under_the_session() {
        let (serving, mut asked) = desktop(true);
        let pointer = Pointer::new(Some(serving), "thr_1");
        pointer.on_line(r#"{"id":1,"x":1,"y":2,"held":false,"phase":"move","mode":"foreground"}"#);
        pointer.on_line("garbage");
        pointer.on_line(r#"{"id":1,"x":3,"y":4,"held":true,"phase":"press","mode":"foreground","window_id":"hwnd:0x3"}"#);
        let mut seen = Vec::new();
        while seen.len() < 2 {
            let params = next(&mut asked).await;
            assert_eq!(params["sessionId"], "thr_1");
            seen.extend(params["events"].as_array().unwrap().iter().map(|event| (event["x"].clone(), event["phase"].clone())));
        }
        assert_eq!(seen, [(json!(1), json!("move")), (json!(3), json!("press"))]);
    }

    #[tokio::test]
    async fn nothing_is_relayed_when_no_desktop_serves_computer() {
        let (absent, mut asked) = desktop(false);
        let pointer = Pointer::new(Some(absent), "thr_1");
        pointer.on_line(r#"{"id":1,"x":1,"y":2,"held":false,"phase":"move"}"#);
        drop(pointer);
        assert!(mixdog_rt::time::timeout(Duration::from_millis(200), asked.recv()).await.map_or(true, |sent| sent.is_none()));
        // With no desktop at all there is no relay to run, and a line is dropped.
        Pointer::new(None, "thr_1").on_line(r#"{"id":1,"x":1,"y":2,"held":false,"phase":"move"}"#);
    }
}
