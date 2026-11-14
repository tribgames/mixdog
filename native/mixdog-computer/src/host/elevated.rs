//! Foreground input to a window above this host's integrity, sent to the
//! platform's elevated worker (host/input-dispatch.ts:139-188) and, in the
//! worker itself, the vetting of the one request it may run
//! (elevated-program.ts).

use super::{Host, Res};
use crate::config::Config;
use crate::lease_api::NoLease;
use crate::observer::Observer;
use crate::platform::{self, parse_window_id, Integrity};
use crate::protocol::{Obj, Req};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Set in the elevated worker, whose host serves its one action itself.
static IN_WORKER: AtomicBool = AtomicBool::new(false);

/// The actions an elevated worker may run (`$allowed`, elevated-program.ts).
const ALLOWED_ACTIONS: [&str; 10] = [
    "click",
    "double_click",
    "right_click",
    "middle_click",
    "triple_click",
    "mouse_move",
    "drag",
    "scroll",
    "key",
    "type",
];

/// How long the worker's fresh observer may take to start reading input.
const OBSERVER_READY: Duration = Duration::from_secs(3);

/// What a foreground request does about a target above this host's integrity.
#[derive(Debug, PartialEq)]
enum Decision {
    /// The normal dispatch.
    Normal,
    Refuse(String),
    Elevate,
}

/// The routing rule of host/input-dispatch.ts:93-188: a foreground input
/// whose target integrity cannot be read is refused (readForegroundIntegrity;
/// `None` is a system with no such boundary), only a target known to run
/// higher goes to the worker, and only with the policy's consent and no
/// element ref (a ref cannot be resolved across the boundary).
fn decide(level: Option<&Integrity>, req: &Req) -> Decision {
    let Some(level) = level else {
        return Decision::Normal;
    };
    if !level.known() {
        return Decision::Refuse(
            "target_integrity_unknown: foreground input was not sent because the target integrity could not be verified"
                .into(),
        );
    }
    if !level.higher() {
        return Decision::Normal;
    }
    if req.bool_false("allow_elevated_input") {
        return Decision::Refuse("computer_policy_denied: elevated input is not authorized".into());
    }
    if has_element_target(req) {
        return Decision::Refuse(
            "privileged_worker_ref_unsupported: use frame-bound coordinates or direct keys/text; no UAC request was opened"
                .into(),
        );
    }
    match validate(req) {
        Ok(()) => Decision::Elevate,
        Err(error) => Decision::Refuse(format!("privileged_worker_failed: {error}")),
    }
}

/// The elevated worker's answer to a foreground request; None when the
/// request takes the normal dispatch.
pub(super) fn route(host: &Host, req: &Req) -> Option<Res<Obj>> {
    if IN_WORKER.load(Ordering::Relaxed) || !req.delivery_foreground() {
        return None;
    }
    let window = parse_window_id(&req.text("window_id"));
    let target = if window == 0 { host.desktop.foreground() } else { window };
    let level = host.desktop.integrity(target);
    match decide(level.as_ref(), req) {
        Decision::Normal => None,
        Decision::Refuse(error) => Some(Err(error)),
        Decision::Elevate => {
            let mut answer = host.desktop.elevated_run(req)?;
            if let (Ok(result), Some(level)) = (&mut answer, &level) {
                annotate(result, level);
            }
            Some(answer)
        }
    }
}

/// A privileged reply says so (annotatePrivilegedResponse).
fn annotate(result: &mut Obj, level: &Integrity) {
    let path = result
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .unwrap_or("foreground_input")
        .to_string();
    result.insert("path".into(), json!(format!("uac_elevated_{path}")));
    result.insert(
        "privilege".into(),
        json!({
            "source_integrity": level.own_name,
            "target_integrity": level.target_name,
            "worker": "one_shot",
        }),
    );
}

fn has_element_target(req: &Req) -> bool {
    req.truthy("ref") || req.truthy("to")
}

/// A `hwnd:0x<hex>` id (`^hwnd:0x[0-9a-fA-F]+$`, matched without case as
/// PowerShell's -match does).
fn exact_window_id(id: &str) -> bool {
    id.get(..7).is_some_and(|head| head.eq_ignore_ascii_case("hwnd:0x"))
        && id.len() > 7
        && id[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// What the worker runs: one allowed foreground action on an exact window,
/// by frame coordinates or direct keys and text, never a destructive chord
/// (the checks of elevated-program.ts, ELEVATED_BOOTSTRAP).
fn validate(req: &Req) -> Result<(), String> {
    let action = req.action();
    if !ALLOWED_ACTIONS.contains(&action.as_str()) {
        return Err(format!("privileged worker action is not allowed: {action}"));
    }
    if !req.delivery_foreground() {
        return Err("privileged worker requires delivery=foreground".into());
    }
    if !exact_window_id(&req.text("window_id")) {
        return Err("privileged worker requires exact window_id".into());
    }
    if has_element_target(req) {
        return Err("privileged worker requires frame-bound coordinates or direct keys/text".into());
    }
    if blocked_keys(req.text("keys").trim()) {
        return Err("privileged worker blocked a destructive or session-ending key combination".into());
    }
    Ok(())
}

/// Modifiers seen in the run of modifier characters just before a key.
#[derive(Default, Clone, Copy)]
struct Run {
    alt: bool,
    ctrl: bool,
    shift: bool,
    win: bool,
}

/// BLOCKED_COMPUTER_KEY_PATTERN_SOURCE (input/guards.ts) read without a
/// regex: Alt+F4, Ctrl+Alt+Delete or End, Shift+Delete, and the system key
/// with L. `plain` is the run of `%+^`, which `#` ends; `any` also takes `#`.
fn blocked_keys(keys: &str) -> bool {
    let chars: Vec<char> = keys.chars().collect();
    let (mut plain, mut any) = (Run::default(), Run::default());
    for (at, &character) in chars.iter().enumerate() {
        match character {
            '%' => (plain.alt, any.alt) = (true, true),
            '^' => (plain.ctrl, any.ctrl) = (true, true),
            '+' => (plain.shift, any.shift) = (true, true),
            '#' => {
                plain = Run::default();
                any.win = true;
            }
            _ => {
                let braced = (character == '{')
                    .then(|| chars[at + 1..].iter().position(|&next| next == '}'))
                    .flatten()
                    .map(|end| chars[at + 1..at + 1 + end].iter().collect::<String>());
                let hit = match braced {
                    Some(inner) => blocked_named(&inner, plain, any),
                    None => character.eq_ignore_ascii_case(&'l') && any.win,
                };
                if hit {
                    return true;
                }
                (plain, any) = (Run::default(), Run::default());
            }
        }
    }
    false
}

/// `{NAME}` or `{NAME n}` (one to three digits) after the modifiers.
fn blocked_named(inner: &str, plain: Run, any: Run) -> bool {
    if inner.eq_ignore_ascii_case("l") {
        return any.win;
    }
    let (name, repeat) = match inner.split_once(char::is_whitespace) {
        Some((name, repeat)) => (name, Some(repeat.trim_start())),
        None => (inner, None),
    };
    let counted = repeat.is_none_or(|repeat| {
        (1..=3).contains(&repeat.len()) && repeat.bytes().all(|byte| byte.is_ascii_digit())
    });
    if !counted {
        return false;
    }
    match name.to_ascii_uppercase().as_str() {
        "F4" => plain.alt,
        "DEL" | "DELETE" => (plain.ctrl && plain.alt) || plain.shift,
        "END" => plain.ctrl && plain.alt,
        _ => false,
    }
}

/// The elevated worker's mode (`--elevated-request <dir> ...`); the process
/// exit code.
pub fn worker(args: &[String]) -> i32 {
    IN_WORKER.store(true, Ordering::Relaxed);
    platform::elevated_worker(args, validate, serve)
}

/// Runs the one request in a host of its own. The observation the unelevated
/// host made belongs to its observer, so the worker begins its own scope
/// instead of resuming that one.
fn serve(line: &str) -> Value {
    let line = match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(mut request)) => {
            request.remove("observed_input_monitor_id");
            request.remove("observed_input_user_sequence");
            Value::Object(request).to_string()
        }
        _ => line.to_string(),
    };
    let cfg = Config::from_env();
    let observer = Observer::new();
    let desktop = platform::create(observer.shared.clone(), cfg.input_marker);
    let started = Instant::now();
    while !observer.read().ready && started.elapsed() < OBSERVER_READY {
        std::thread::sleep(Duration::from_millis(25));
    }
    Host::new(cfg, desktop, observer, Box::new(NoLease)).reply(&line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(own: i32, target: i32) -> Integrity {
        Integrity { own_rid: own, target_rid: target, own_name: "medium", target_name: "high" }
    }

    fn click(extra: Value) -> Req {
        let mut request = json!({
            "action": "click",
            "delivery": "foreground",
            "window_id": "hwnd:0x2a",
            "allow_elevated_input": true,
        });
        request.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        Req(request)
    }

    #[test]
    fn only_a_target_known_to_run_higher_is_elevated() {
        let request = click(json!({}));
        assert_eq!(decide(Some(&level(0x2000, 0x3000)), &request), Decision::Elevate);
        assert_eq!(decide(Some(&level(0x2000, 0x2000)), &request), Decision::Normal);
        assert_eq!(decide(Some(&level(0x3000, 0x2000)), &request), Decision::Normal);
        assert_eq!(decide(None, &request), Decision::Normal);
    }

    #[test]
    fn a_target_whose_integrity_cannot_be_read_is_refused() {
        let refusal = Decision::Refuse(
            "target_integrity_unknown: foreground input was not sent because the target integrity could not be verified"
                .into(),
        );
        let request = click(json!({}));
        assert_eq!(decide(Some(&level(0x2000, 0)), &request), refusal);
        assert_eq!(decide(Some(&level(0, 0x3000)), &request), refusal);
    }

    #[test]
    fn a_policy_that_forbids_elevated_input_refuses_before_any_prompt() {
        let request = click(json!({ "allow_elevated_input": false }));
        assert_eq!(
            decide(Some(&level(0x2000, 0x3000)), &request),
            Decision::Refuse("computer_policy_denied: elevated input is not authorized".into())
        );
        // Without the policy's say the caller's default is to allow.
        let silent = Req(json!({ "action": "click", "delivery": "foreground", "window_id": "hwnd:0x2a" }));
        assert_eq!(decide(Some(&level(0x2000, 0x3000)), &silent), Decision::Elevate);
    }

    #[test]
    fn a_ref_or_a_destination_is_refused_before_the_prompt() {
        for extra in [json!({ "ref": "e3" }), json!({ "to": { "x": 1, "y": 2 } })] {
            assert_eq!(
                decide(Some(&level(0x2000, 0x3000)), &click(extra)),
                Decision::Refuse(
                    "privileged_worker_ref_unsupported: use frame-bound coordinates or direct keys/text; no UAC request was opened"
                        .into()
                )
            );
        }
    }

    #[test]
    fn a_request_the_worker_would_refuse_never_opens_the_prompt() {
        let high = level(0x2000, 0x3000);
        assert_eq!(
            decide(Some(&high), &click(json!({ "action": "focus_window" }))),
            Decision::Refuse("privileged_worker_failed: privileged worker action is not allowed: focus_window".into())
        );
        assert_eq!(
            decide(Some(&high), &click(json!({ "action": "key", "keys": "%{F4}" }))),
            Decision::Refuse(
                "privileged_worker_failed: privileged worker blocked a destructive or session-ending key combination"
                    .into()
            )
        );
    }

    #[test]
    fn the_worker_vets_the_action_delivery_window_and_target() {
        assert_eq!(validate(&click(json!({}))), Ok(()));
        for action in ["double_click", "key", "type", "scroll", "drag", "mouse_move"] {
            assert_eq!(validate(&click(json!({ "action": action }))), Ok(()), "{action}");
        }
        assert_eq!(
            validate(&click(json!({ "action": "invoke" }))),
            Err("privileged worker action is not allowed: invoke".into())
        );
        assert_eq!(
            validate(&click(json!({ "delivery": "background" }))),
            Err("privileged worker requires delivery=foreground".into())
        );
        for id in ["", "hwnd:0x", "hwnd:0xzz", "0x2a", "hwnd:0x2a ", "hwnd:2a"] {
            assert_eq!(
                validate(&click(json!({ "window_id": id }))),
                Err("privileged worker requires exact window_id".into()),
                "{id:?}"
            );
        }
        assert_eq!(validate(&click(json!({ "window_id": "HWND:0X2A" }))), Ok(()));
        assert_eq!(
            validate(&click(json!({ "ref": "e1" }))),
            Err("privileged worker requires frame-bound coordinates or direct keys/text".into())
        );
    }

    #[test]
    fn destructive_chords_are_blocked_as_input_guards_names_them() {
        for keys in [
            "%{F4}", "%+{F4 2}", "^%{DEL}", "^%{delete}", "^%{END}", "+{DEL}", "^+{DELETE 3}",
            "#l", "#L", "+#l", "#{L}", "{ENTER}#l",
        ] {
            assert!(blocked_keys(keys), "{keys}");
        }
        for keys in [
            "{F4}", "^{F4}", "%{DEL}", "^{DEL}", "^{END}", "%{END}", "{DEL}", "#a", "l", "{L}",
            "%a{F4}", "%#{F4}", "#{ENTER}l", "%{F4 1234}", "^%{DEL x}", "^c", "hello world",
        ] {
            assert!(!blocked_keys(keys), "{keys}");
        }
    }

    #[test]
    fn a_privileged_reply_is_marked_with_both_integrities() {
        let mut result = json!({ "path": "foreground_click", "text": "ok" }).as_object().unwrap().clone();
        annotate(&mut result, &level(0x2000, 0x3000));
        assert_eq!(result["path"], json!("uac_elevated_foreground_click"));
        assert_eq!(
            result["privilege"],
            json!({ "source_integrity": "medium", "target_integrity": "high", "worker": "one_shot" })
        );
        let mut bare = Obj::new();
        annotate(&mut bare, &level(0x2000, 0x3000));
        assert_eq!(bare["path"], json!("uac_elevated_foreground_input"));
    }
}
