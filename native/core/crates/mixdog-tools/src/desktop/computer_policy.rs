//! Observation-only mode (`host/observation-policy.ts`): the live `desktop.computerObserveOnly` setting, checked when a call is
//! admitted and on every request the helper is sent. Also the one part of the execution policy (`host/execution-policy.ts`) the
//! core has a source for: whether input may ask for elevation.

use mixdog_core_api::domain::computer::ComputerError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::computer_backend::HelperFailure;
use super::computer_command::text;
use super::computer_env::RETAIN_REF_ACTIONS;

/// `OBSERVE_ONLY_ALLOWED_ACTIONS` (`computerActionsWith('observeOnly')`, `computer-bridge/actions.mjs`): every read of the
/// helper and of the host, `diagnose`, and the lifecycle controls. Anything else could change the desktop.
const OBSERVE_ONLY_ALLOWED_ACTIONS: [&str; 31] = [
    "list_windows",
    "window_snapshot",
    "related_windows",
    "snapshot",
    "find",
    "clipboard_read",
    "wait",
    "window_bounds",
    "window_capture",
    "validate_background_input",
    "window_predicates",
    "accessibility_probe",
    "window_integrity",
    "input_recovery_state",
    "input_idle_state",
    "ocr_image",
    "ocr_status",
    "process_fate",
    "list_apps",
    "list_installed_apps",
    "list_history",
    "capture",
    "screenshot",
    "zoom",
    "verify",
    "diagnose",
    "wait_for_user",
    "execution_end",
    "session_release",
    "session_abort",
    "turn_settle",
];

/// `createComputerExecutionPolicy()` with no policy file (`execution-policy.ts:23`): input to a window of higher integrity may
/// ask for elevation. The core has no source for a restricting policy, so this is the value every request carries.
const ALLOW_ELEVATED_INPUT: bool = true;

/// `assertObservationInputAllowed` at admission, on the helper command a call became, before anything is spawned or sent: while
/// observation-only mode is on, a command that is not a read is refused in the desktop host's words.
pub(super) fn admit(command: &Map<String, Value>, observe_only: bool) -> Result<(), ComputerError> {
    let action = text(command, "action");
    if !observe_only || OBSERVE_ONLY_ALLOWED_ACTIONS.contains(&action) {
        return Ok(());
    }
    let refusal = format!(
        "observation_only: Computer Use is observing only, so '{action}' input is blocked. Turn off \"Observation only\" in Settings to allow input."
    );
    Err(HelperFailure { text: refusal, result: None }.into_error())
}

/// What the policy adds to a helper request. While observation-only mode is on it is marked read-only, so the helper refuses
/// any mutation in it; a request that hands input back (`release_held_input`, `release_session`, ...) goes as it is: the desktop
/// host sends those with `read_only: false` (`session-lifecycle.ts:100`, `lifecycle-abort.ts:185,297`, `worker-control.ts:26`),
/// so observing only never leaves a key or button down. Every request says whether its input may ask for elevation
/// (`assertElevated`, `execution-policy.ts:118-121`), which the helper checks before it opens a UAC prompt.
pub(super) fn decorate(command: &mut Map<String, Value>, observe_only: bool, windows_helper: bool) {
    let hands_back = command.get("action").and_then(Value::as_str).is_some_and(|action| RETAIN_REF_ACTIONS.contains(&action));
    if observe_only && !hands_back {
        command.insert("read_only".into(), json!(true));
    }
    if windows_helper {
        command.insert("allow_elevated_input".into(), json!(ALLOW_ELEVATED_INPUT));
    }
}

/// Input from the in-process screen half (`ComputerBackend::inject`) is denied while observation-only mode is on.
pub(super) fn admit_screen_input(observe_only: bool) -> Result<(), ComputerError> {
    if observe_only { Err(ComputerError::Denied) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerRequest;
    use tokio_util::sync::CancellationToken;

    use super::super::computer_backend::ComputerConfig;
    use super::super::computer_backend::ComputerShared;
    use super::super::computer_backend::ProcessComputerBackend;
    use super::super::computer_targets::testing::Scripted;
    use super::*;

    fn command(action: &str) -> Map<String, Value> {
        json!({ "action": action }).as_object().cloned().unwrap_or_default()
    }

    fn refusal(action: &str) -> ComputerError {
        ComputerError::Failed {
            code: "observation_only".into(),
            message: format!(
                "observation_only: Computer Use is observing only, so '{action}' input is blocked. Turn off \"Observation only\" in Settings to allow input."
            ),
        }
    }

    /// The commands a tool call becomes: the reads pass while observing only, and each one that could change the desktop is
    /// refused under the name the desktop host refuses it by. With the mode off nothing is refused.
    #[test]
    fn observing_only_admits_reads_and_refuses_every_input() {
        for read in ["list_windows", "list_apps", "list_history", "capture", "zoom", "verify", "diagnose", "wait_for_user", "clipboard_read"] {
            assert_eq!(admit(&command(read), true), Ok(()), "{read}");
        }
        let inputs = [
            "sequence",
            "focus_window",
            "move_window",
            "window_state",
            "close_window",
            "terminate_process",
            "invoke_menu",
            "clipboard_write",
            "launch",
            "fill_saved_login",
            "click",
            "type",
            "key",
        ];
        for input in inputs {
            assert_eq!(admit(&command(input), true), Err(refusal(input)), "{input}");
            assert_eq!(admit(&command(input), false), Ok(()), "{input}");
        }
    }

    /// Every request says elevation may be asked for; only a request that hands input back stays writable while observing only.
    #[test]
    fn requests_carry_the_policy() {
        let decorated = |action: &str, observe_only: bool| {
            let mut command = command(action);
            decorate(&mut command, observe_only, true);
            Value::Object(command)
        };
        assert_eq!(decorated("click", false), json!({"action":"click","allow_elevated_input":true}));
        assert_eq!(decorated("click", true), json!({"action":"click","read_only":true,"allow_elevated_input":true}));
        assert_eq!(decorated("release_held_input", true), json!({"action":"release_held_input","allow_elevated_input":true}));
    }

    #[test]
    fn screen_input_is_denied_while_observing_only() {
        assert_eq!(admit_screen_input(true), Err(ComputerError::Denied));
        assert_eq!(admit_screen_input(false), Ok(()));
    }

    /// A secret typed by a handoff goes through `execute`, which `run` does not: observing only refuses its `type` in the host's
    /// words and still admits its `find`.
    #[tokio::test]
    async fn observing_only_refuses_a_secret_type_but_admits_its_find() {
        use crate::state::secrets::ComputerSecretHost;

        let manager = Scripted::new(|_| Ok(json!({"text":"ok"})));
        let shared = ComputerShared { observe_only: Arc::new(|| true), ..ComputerShared::default() };
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared);
        let refused = ComputerSecretHost::execute(&backend, command("type")).await;
        assert_eq!(refused, Err("observation_only: Computer Use is observing only, so 'type' input is blocked. Turn off \"Observation only\" in Settings to allow input.".to_owned()));
        assert_eq!(manager.starts(), 0, "nothing was started");
        assert!(ComputerSecretHost::execute(&backend, command("find")).await.is_ok());
    }

    /// The live setting through the backend: while it is on an `act` is refused in the host's words before the helper is even
    /// started, and every request a read becomes goes read-only; turned off, the next `act` reaches the helper as input.
    #[tokio::test]
    async fn the_live_setting_blocks_input_before_anything_is_written() {
        let manager = Scripted::new(|_| Ok(json!({"text":"ok"})));
        let on = Arc::new(AtomicBool::new(true));
        let setting = on.clone();
        let shared = ComputerShared { observe_only: Arc::new(move || setting.load(Ordering::SeqCst)), ..ComputerShared::default() };
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared);
        let act = || ComputerRequest { action: ComputerAction::Act, input: json!({"window_id":"hwnd:0x2","actions":[{"type":"key","keys":"a"}]}) };
        let list = || ComputerRequest { action: ComputerAction::List, input: json!({"kind":"windows"}) };

        assert_eq!(backend.run(act(), CancellationToken::new()).await, Err(refusal("sequence")));
        assert_eq!((manager.starts(), manager.lines().len()), (0, 0), "nothing was started or written");

        backend.run(list(), CancellationToken::new()).await.unwrap();
        let reads = manager.lines();
        assert!(!reads.is_empty());
        assert!(reads.iter().all(|line| line["read_only"] == json!(true)), "{reads:?}");

        on.store(false, Ordering::SeqCst);
        backend.run(act(), CancellationToken::new()).await.unwrap();
        let sent = manager.lines();
        let writable: Vec<&Value> = sent[reads.len()..].iter().filter(|line| line.get("read_only").is_none()).collect();
        assert!(!writable.is_empty(), "the act's input is not a read-only run: {sent:?}");
        assert!(writable.iter().all(|line| line["allow_elevated_input"] == json!(true)), "{sent:?}");
    }
}
