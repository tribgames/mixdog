//! Owner: s4-engine-runner
//! The two checks every command passes at the engine's door: the secret guard (`guardBrowserSecrets` of `agent-bridge.ts`) and the
//! revalidation of the command before any page work (`prepareBrowserCommand` of `command-runner.ts`).
//!
//! The guard is the one place a reply leaves the engine: whatever the core filled into a page for this session (a password, a one-time
//! code, an ask_user or agent-typed secret; never a username, which the agent may read) is replaced by a fixed marker in the reply's text
//! and in an error's message. The values belong to the core's secret input; the engine only asks it through [`SecretGuard`].

use serde_json::Map;
use serde_json::Value;

use crate::actions::registry::Action;
use crate::reply::reply::ToolReply;
use crate::settle::postcondition::Postcondition;
use crate::settle::postcondition::normalize;
use crate::settle::postcondition::normalize_settle_ms;

/// What the core's secret input knows of a session.
pub trait SecretGuard: Send + Sync {
    /// `text` with every secret the session filled replaced by its marker.
    fn redact(&self, session_id: &str, text: &str) -> String;
    /// Registers a value before a page sees it, so no later reply of the session repeats it.
    fn remember(&self, session_id: &str, secret: &str);
}

/// A reply as it leaves the engine.
pub fn guard_reply(guard: &dyn SecretGuard, session_id: &str, mut reply: ToolReply) -> ToolReply {
    reply.text = guard.redact(session_id, &reply.text);
    reply
}

/// An error message as it leaves the engine.
pub fn guard_message(guard: &dyn SecretGuard, session_id: &str, message: &str) -> String {
    guard.redact(session_id, message)
}

/// A command that passed the checks: the action, the command object the handlers read (the input with its runtime-set fields), and
/// what the flow decides on before the page is touched.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub action: Action,
    /// The input, with `action` (normalized), `session_id` and `turn_id` as the handlers read them.
    pub command: Value,
    /// A hidden offscreen page rather than the visible tab. An `open` is never in the background unless it says so.
    pub background: bool,
    /// The tab the command names; empty when none.
    pub tab: String,
    pub expected: Option<Postcondition>,
    pub has_screenshot_options: bool,
}

/// Validates and normalizes one command before any page work: the action, the screenshot options, the settle delay and the
/// postcondition. `turn_id` is the turn the command runs in (`0`: none).
pub fn prepare(action: &str, input: &Map<String, Value>, session_id: &str, turn_id: u64) -> Result<Prepared, String> {
    let name = action.trim();
    if name.is_empty() {
        return Err("browser command requires action".to_owned());
    }
    let Some(parsed) = Action::parse(name) else {
        return Err(format!("unknown browser action \"{name}\""));
    };
    if input.contains_key("internalStep") {
        return Err("internalStep is not a bridge input".to_owned());
    }
    let has_screenshot_options = ["fullPage", "format", "quality"].iter().any(|key| input.contains_key(*key));
    if parsed != Action::Snapshot && has_screenshot_options && input.get("includeScreenshot") != Some(&Value::Bool(true)) {
        return Err(format!("{} screenshot options require includeScreenshot=true", parsed.name()));
    }
    normalize_settle_ms(input.get("settleMs")).map_err(|error| error.to_string())?;
    let expected = normalize(input.get("expect")).map_err(|error| error.to_string())?;
    if expected.is_some() && !crate::limits::POSTCONDITION_ACTIONS.contains(&parsed.name()) {
        return Err(format!("expect is not supported for browser action \"{}\"", parsed.name()));
    }
    let background = input.get("background") == Some(&Value::Bool(true));
    let tab = input.get("tab").and_then(Value::as_str).map(|tab| mixdog_js::js_trim(tab).to_owned()).unwrap_or_default();
    let mut command = input.clone();
    command.insert("action".to_owned(), Value::String(parsed.name().to_owned()));
    command.insert("session_id".to_owned(), Value::String(session_id.to_owned()));
    command.insert("turn_id".to_owned(), Value::from(turn_id));
    Ok(Prepared { action: parsed, command: Value::Object(command), background, tab, expected, has_screenshot_options })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Masks;

    impl SecretGuard for Masks {
        fn redact(&self, _session_id: &str, text: &str) -> String {
            text.replace("hunter2", "[secret]")
        }

        fn remember(&self, _session_id: &str, _secret: &str) {}
    }

    fn input(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    #[test]
    fn the_guard_masks_a_reply_and_an_error_message() {
        let reply = guard_reply(&Masks, "s1", ToolReply::text("password hunter2 typed"));
        assert_eq!(reply.text, "password [secret] typed");
        assert_eq!(guard_message(&Masks, "s1", "could not type hunter2"), "could not type [secret]");
    }

    #[test]
    fn an_unknown_or_empty_action_is_refused_and_a_known_one_is_normalized() {
        assert_eq!(prepare("", &input(json!({})), "s1", 1).unwrap_err(), "browser command requires action");
        assert_eq!(prepare("teleport", &input(json!({})), "s1", 1).unwrap_err(), "unknown browser action \"teleport\"");
        let prepared = prepare(" Click ", &input(json!({"ref": "p1-s1-e1"})), "s1", 4).expect("click");
        assert_eq!(prepared.action, Action::Click);
        assert_eq!(prepared.command["action"], "click");
        assert_eq!((prepared.command["session_id"].as_str(), prepared.command["turn_id"].as_u64()), (Some("s1"), Some(4)));
    }

    #[test]
    fn an_internal_step_is_not_an_input() {
        assert_eq!(prepare("click", &input(json!({"internalStep": true})), "s1", 1).unwrap_err(), "internalStep is not a bridge input");
    }

    #[test]
    fn screenshot_options_need_the_screenshot_except_on_a_snapshot() {
        assert_eq!(prepare("click", &input(json!({"fullPage": true})), "s1", 1).unwrap_err(), "click screenshot options require includeScreenshot=true");
        assert!(prepare("click", &input(json!({"fullPage": true, "includeScreenshot": true})), "s1", 1).is_ok());
        assert!(prepare("snapshot", &input(json!({"format": "png"})), "s1", 1).unwrap().has_screenshot_options);
    }

    #[test]
    fn a_postcondition_is_only_for_the_actions_that_verify_one() {
        let error = prepare("read", &input(json!({"expect": {"text": "Done"}})), "s1", 1).unwrap_err();
        assert_eq!(error, "expect is not supported for browser action \"read\"");
        let prepared = prepare("click", &input(json!({"expect": {"text": "Done"}})), "s1", 1).unwrap();
        assert!(prepared.expected.is_some());
    }

    #[test]
    fn only_an_open_that_says_so_runs_in_the_background() {
        assert!(!prepare("open", &input(json!({})), "s1", 1).unwrap().background);
        assert!(prepare("open", &input(json!({"background": true})), "s1", 1).unwrap().background);
        assert!(prepare("snapshot", &input(json!({"background": true, "tab": " research "})), "s1", 1).unwrap().background);
        assert_eq!(prepare("snapshot", &input(json!({"tab": " research "})), "s1", 1).unwrap().tab, "research");
    }
}
