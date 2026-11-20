//! The argument checks of the UI browser/command actions, with the refusal texts of
//! `shared/remote-browser.ts`, `shared/browser-page-control.ts` and the host's action table
//! (`main/host/browser-command.ts` `REMOTE_ACTIONS`). The core runs them for every origin before
//! a command is forwarded; the corpus `fixtures/browser-parity/remote-browser.json` is read by
//! the desktop's own test too, so both sides refuse the same input with the same text.

use mixdog_core_api::CoreError;
use mixdog_js::utf16_len as len16;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

type Checked<T> = Result<T, String>;

const MAX_REMOTE_BROWSER_TEXT: usize = 2_000;
const MAX_TAB_URL: usize = 4_096;
const MIN_DRIVE_DIMENSION: f64 = 200.0;
const MAX_DRIVE_DIMENSION: f64 = 3_840.0;
const MIN_DRIVE_SCALE: f64 = 0.5;
const MAX_DRIVE_SCALE: f64 = 4.0;
const MAIN_BROWSER_PAGE_PREFIX: &str = "main-browser-";

/// The refusal as the desktop's `TypeError` carried it: an error with no code.
fn refused(message: String) -> CoreError {
    CoreError::DomainError { domain: "browser".into(), code: None, message: Some(message.into()), detail: None }
}

fn invalid<T>(message: &str) -> Checked<T> {
    Err(message.to_owned())
}

/// `Number.isSafeInteger` on a JSON value.
fn safe_integer(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number)
}

/// `String(value || '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Number(number)) if number.as_f64().is_none_or(|n| n == 0.0 || n.is_nan()) => String::new(),
        Some(other) => value_to_string(other),
    }
}

fn is_ascii_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `/^p\d+$/u`.
fn is_page_id(text: &str) -> bool {
    text.strip_prefix('p').is_some_and(is_ascii_digits)
}

/// The remote layer's `/^p[1-9]\d*:\d+$/u`.
fn is_document_id(text: &str) -> bool {
    let Some((page, token)) = text.strip_prefix('p').and_then(|rest| rest.split_once(':')) else {
        return false;
    };
    is_ascii_digits(page) && is_ascii_digits(token) && !page.starts_with('0')
}

fn viewport(input: &Map<String, Value>) -> Checked<()> {
    let dimension = |name: &str| safe_integer(input.get(name)).is_some_and(|n| (MIN_DRIVE_DIMENSION..=MAX_DRIVE_DIMENSION).contains(&n));
    if !dimension("width") || !dimension("height") {
        return invalid("remote browser viewport size is invalid.");
    }
    match input.get("deviceScaleFactor").and_then(Value::as_f64) {
        Some(scale) if (MIN_DRIVE_SCALE..=MAX_DRIVE_SCALE).contains(&scale) => Ok(()),
        _ => invalid("remote browser viewport scale is invalid."),
    }
}

/// `number(name, min, max)` of `normalizeBrowserPageControl`.
fn number(input: &Map<String, Value>, name: &str, min: f64, max: f64) -> Checked<f64> {
    match input.get(name).and_then(Value::as_f64) {
        Some(value) if value >= min && value <= max => Ok(value),
        _ => Err(format!("Browser {name} is invalid.")),
    }
}

/// `text(name, limit)` of `normalizeBrowserPageControl`.
fn text(input: &Map<String, Value>, name: &str, limit: usize) -> Checked<()> {
    match input.get(name) {
        Some(Value::String(value)) if !value.is_empty() && len16(value) <= limit => Ok(()),
        _ => Err(format!("Browser {name} is invalid.")),
    }
}

fn dialog_answer(input: &Map<String, Value>) -> Checked<()> {
    let prompt_ok = input.get("promptText").is_none_or(|v| v.as_str().is_some_and(|s| len16(s) <= 2000));
    let keep_ok = input.get("keepDefault").is_none_or(Value::is_boolean);
    let remember_ok = input.get("remember").is_none_or(|v| matches!(v.as_str(), Some("site" | "all")));
    if !input.get("accept").is_some_and(Value::is_boolean) || !prompt_ok || !keep_ok || !remember_ok {
        return invalid("Browser dialog answer is invalid.");
    }
    text(input, "requestId", 100)?;
    if input.contains_key("deviceId") {
        text(input, "deviceId", 200)?;
    }
    Ok(())
}

fn composition(input: &Map<String, Value>, ended: bool) -> Checked<()> {
    let Some(value) = input.get("text").and_then(Value::as_str).filter(|s| len16(s) <= 32_000) else {
        return invalid("Browser composition text is invalid.");
    };
    if ended {
        return Ok(());
    }
    let start = number(input, "selectionStart", 0.0, len16(value) as f64)?;
    let end = number(input, "selectionEnd", start, len16(value) as f64)?;
    if start.fract() != 0.0 || end.fract() != 0.0 {
        return invalid("Browser composition selection is invalid.");
    }
    Ok(())
}

fn pointer(input: &Map<String, Value>) -> Checked<()> {
    let member = |name: &str, set: &[&str]| input.get(name).is_some_and(|v| set.contains(&value_to_string(v).as_str()));
    if !member("phase", &["mouseMoved", "mousePressed", "mouseReleased"]) || !member("button", &["none", "left", "middle", "right"]) {
        return invalid("Browser pointer is invalid.");
    }
    number(input, "x", 0.0, 100_000.0)?;
    number(input, "y", 0.0, 100_000.0)?;
    number(input, "buttons", 0.0, 7.0)?;
    number(input, "modifiers", 0.0, 15.0)?;
    number(input, "clickCount", 0.0, 3.0)?;
    Ok(())
}

fn wheel(input: &Map<String, Value>) -> Checked<()> {
    number(input, "x", 0.0, 100_000.0)?;
    number(input, "y", 0.0, 100_000.0)?;
    number(input, "deltaX", -20_000.0, 20_000.0)?;
    number(input, "deltaY", -20_000.0, 20_000.0)?;
    Ok(())
}

/// `normalizeRemoteBrowserControl`, over the fields the host takes from `input`.
fn page_control(input: &Map<String, Value>) -> Checked<()> {
    let kind = string_or_empty(input.get("type"));
    match kind.as_str() {
        "navigate" => match input.get("url") {
            Some(Value::String(url)) if (1..=4_096).contains(&len16(url)) => Ok(()),
            _ => invalid("remote browser url is invalid."),
        },
        "back" | "forward" | "reload" | "stop" | "new-tab" => Ok(()),
        "select-tab" | "close-tab" => match input.get("tabId") {
            Some(Value::String(id)) if len16(id) <= 80 && is_page_id(id) => Ok(()),
            _ => invalid("remote browser tab id is invalid."),
        },
        "viewport" => viewport(input),
        "pointer" | "wheel" | "text" | "key" | "composition" | "composition-end" | "answer-dialog" => {
            match input.get("documentId") {
                Some(Value::String(id)) if len16(id) <= 64 && is_document_id(id) => {}
                _ => return invalid("remote browser document id is invalid."),
            }
            let carries_text = matches!(kind.as_str(), "text" | "composition" | "composition-end");
            if carries_text && !input.get("text").and_then(Value::as_str).is_some_and(|s| len16(s) <= MAX_REMOTE_BROWSER_TEXT) {
                return invalid("remote browser text is invalid.");
            }
            // `normalizeBrowserPageControl` switches on the raw `type`: a non-string that coerces to a kind is unknown there.
            if !input.get("type").is_some_and(Value::is_string) {
                return invalid("Unknown browser input.");
            }
            match kind.as_str() {
                "answer-dialog" => dialog_answer(input),
                "text" => text(input, "text", 32_000),
                "key" => text(input, "key", 64),
                "composition" => composition(input, false),
                "composition-end" => composition(input, true),
                "pointer" => pointer(input),
                _ => wheel(input),
            }
        }
        _ => Err(format!("unknown remote browser control \"{}\".", if kind.is_empty() { "(none)" } else { &kind })),
    }
}

/// `normalizeRemoteBrowserTabId`: a main-workspace browser page id.
fn main_tab_id(value: Option<&Value>) -> Checked<()> {
    match value {
        Some(Value::String(id))
            if id.starts_with(MAIN_BROWSER_PAGE_PREFIX) && len16(id) <= 256 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
        {
            Ok(())
        }
        _ => invalid("Browser page is not a main tab page."),
    }
}

/// `normalizeBrowserImportRequest`.
fn import_request(request: &Map<String, Value>) -> Checked<()> {
    let job = string_or_empty(request.get("jobId"));
    let source = string_or_empty(request.get("sourceId"));
    let profile = string_or_empty(request.get("profileId"));
    let items: Vec<String> = match request.get("items") {
        Some(Value::Array(items)) => items.iter().map(value_to_string).collect(),
        _ => Vec::new(),
    };
    let job_ok = (8..=120).contains(&job.len()) && job.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !job_ok {
        return invalid("Browser import job id is invalid.");
    }
    if source.is_empty() || len16(&source) > 100 {
        return invalid("Browser import source id is invalid.");
    }
    if profile.is_empty() || len16(&profile) > 200 {
        return invalid("Browser import profile id is invalid.");
    }
    if items.is_empty() || items.len() > 3 || items.iter().any(|item| !matches!(item.as_str(), "passwords" | "cookies" | "history")) {
        return invalid("Browser import items are invalid.");
    }
    Ok(())
}

/// The check the host applies to a UI action's `input`; an action outside the table is a tool
/// action and passes (its contract is checked where it runs). `input` is the command's `input`
/// (null when it carried none); an input that is not an object passes, for the host refuses it
/// with its own text (`objectParams`: `input expects an object.`). A credential action's
/// `session_id` is checked as the host's `requiredSessionId` does; a gesture's session is the
/// caller's (`domain_browser`).
pub fn validate_ui_action(action: &str, input: &mut Value) -> Result<(), CoreError> {
    let empty = Map::new();
    let fields = match &*input {
        Value::Object(fields) => fields,
        Value::Null => &empty,
        _ => return Ok(()),
    };
    let session = |fields: &Map<String, Value>| crate::domain_visualize::required_session_id(fields.get("session_id"));
    let checked = match action {
        "input" => page_control(fields),
        "history" => match fields.get("query") {
            Some(Value::String(query)) if len16(query) <= 500 => Ok(()),
            _ => invalid("Browser history query is invalid."),
        },
        "tabOpen" => match fields.get("url") {
            Some(Value::String(url)) if (1..=MAX_TAB_URL).contains(&len16(url)) => Ok(()),
            _ => invalid("remote browser url is invalid."),
        },
        "release" => main_tab_id(fields.get("id")),
        "credentialSuggestions" => session(fields).map(drop),
        "credentialFill" => session(fields).and_then(|_| match fields.get("credentialId") {
            Some(Value::String(id)) if id.len() == 24 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => Ok(()),
            _ => invalid("Stored browser credential id is invalid."),
        }),
        "importSources" => Ok(()),
        "importStart" => import_request(fields),
        _ => Ok(()),
    };
    checked.map_err(refused)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_tool_action_and_an_empty_input_are_not_refused_here() {
        assert!(validate_ui_action("navigate", &mut Value::Null).is_ok());
        assert!(validate_ui_action("importSources", &mut json!({})).is_ok());
        assert!(validate_ui_action("history", &mut json!("x")).is_ok(), "the host answers a non-object input");
        assert!(validate_ui_action("importStart", &mut json!([1])).is_ok(), "the host answers an array input");
        let Err(CoreError::DomainError { message, .. }) = validate_ui_action("input", &mut Value::Null) else { panic!("refused") };
        assert_eq!(message.as_deref(), Some("unknown remote browser control \"(none)\"."));
    }

    fn refusal(action: &str, mut input: Value) -> Option<String> {
        match validate_ui_action(action, &mut input) {
            Ok(()) => None,
            Err(CoreError::DomainError { domain, code: None, message, detail: None }) => {
                assert_eq!(&*domain, "browser");
                message.map(|m| m.to_string())
            }
            Err(other) => panic!("{other:?}"),
        }
    }

    const DOC: &str = "p1:7";

    #[test]
    fn a_navigation_needs_a_url_of_one_to_4096_units_and_a_new_tab_the_same() {
        assert_eq!(refusal("input", json!({"type": "navigate", "url": "https://example.com"})), None);
        assert_eq!(refusal("input", json!({"type": "navigate", "url": ""})).as_deref(), Some("remote browser url is invalid."));
        assert_eq!(refusal("input", json!({"type": "navigate"})).as_deref(), Some("remote browser url is invalid."));
        assert_eq!(refusal("tabOpen", json!({"url": "x".repeat(4096)})), None);
        assert_eq!(refusal("tabOpen", json!({"url": "x".repeat(4097)})).as_deref(), Some("remote browser url is invalid."));
    }

    #[test]
    fn an_unknown_or_missing_control_type_is_named_in_the_refusal() {
        assert_eq!(refusal("input", json!({"type": "teleport"})).as_deref(), Some("unknown remote browser control \"teleport\"."));
        assert_eq!(refusal("input", json!({})).as_deref(), Some("unknown remote browser control \"(none)\"."));
        for plain in ["back", "forward", "reload", "stop", "new-tab"] {
            assert_eq!(refusal("input", json!({"type": plain})), None, "{plain}");
        }
    }

    #[test]
    fn tab_ids_are_p_followed_by_digits() {
        assert_eq!(refusal("input", json!({"type": "select-tab", "tabId": "p12"})), None);
        for bad in ["12", "p", "px", "p1x", ""] {
            assert_eq!(refusal("input", json!({"type": "close-tab", "tabId": bad})).as_deref(), Some("remote browser tab id is invalid."), "{bad:?}");
        }
    }

    #[test]
    fn a_viewport_is_200_to_3840_pixels_with_a_scale_of_half_to_four() {
        let view = |w: f64, h: f64, s: f64| refusal("input", json!({"type": "viewport", "width": w, "height": h, "deviceScaleFactor": s}));
        assert_eq!(view(200.0, 3840.0, 0.5), None);
        assert_eq!(view(199.0, 800.0, 1.0).as_deref(), Some("remote browser viewport size is invalid."));
        assert_eq!(view(800.0, 3841.0, 1.0).as_deref(), Some("remote browser viewport size is invalid."));
        assert_eq!(view(800.5, 600.0, 1.0).as_deref(), Some("remote browser viewport size is invalid."));
        assert_eq!(view(800.0, 600.0, 4.5).as_deref(), Some("remote browser viewport scale is invalid."));
    }

    #[test]
    fn gestures_need_a_document_id_of_the_form_p_page_colon_token() {
        for bad in ["p0:1", "1:1", "p1", "p1:", "p1:x", ""] {
            assert_eq!(refusal("input", json!({"type": "wheel", "documentId": bad})).as_deref(), Some("remote browser document id is invalid."), "{bad:?}");
        }
        assert_eq!(refusal("input", json!({"type": "wheel"})).as_deref(), Some("remote browser document id is invalid."));
    }

    #[test]
    fn a_pointer_names_its_phase_and_button_and_keeps_its_numbers_in_range() {
        let pointer = |patch: Value| {
            let mut input = json!({"type": "pointer", "documentId": DOC, "phase": "mousePressed", "button": "left", "x": 10, "y": 20, "buttons": 1, "modifiers": 0, "clickCount": 1});
            input.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            refusal("input", input)
        };
        assert_eq!(pointer(json!({})), None);
        assert_eq!(pointer(json!({"phase": "mouseDragged"})).as_deref(), Some("Browser pointer is invalid."));
        assert_eq!(pointer(json!({"button": "back"})).as_deref(), Some("Browser pointer is invalid."));
        assert_eq!(pointer(json!({"x": -1})).as_deref(), Some("Browser x is invalid."));
        assert_eq!(pointer(json!({"buttons": 8})).as_deref(), Some("Browser buttons is invalid."));
        assert_eq!(pointer(json!({"modifiers": 16})).as_deref(), Some("Browser modifiers is invalid."));
        assert_eq!(pointer(json!({"clickCount": 4})).as_deref(), Some("Browser clickCount is invalid."));
    }

    #[test]
    fn a_wheel_delta_is_within_twenty_thousand() {
        let wheel = |dy: i64| refusal("input", json!({"type": "wheel", "documentId": DOC, "x": 1, "y": 1, "deltaX": 0, "deltaY": dy}));
        assert_eq!(wheel(20_000), None);
        assert_eq!(wheel(-20_001).as_deref(), Some("Browser deltaY is invalid."));
    }

    #[test]
    fn typed_text_is_capped_at_two_thousand_units_for_the_remote_and_a_key_name_at_sixty_four() {
        let text = |t: String| refusal("input", json!({"type": "text", "documentId": DOC, "text": t}));
        assert_eq!(text("a".repeat(2000)), None);
        assert_eq!(text("a".repeat(2001)).as_deref(), Some("remote browser text is invalid."));
        assert_eq!(text(String::new()).as_deref(), Some("Browser text is invalid."), "an empty text is not an input");
        let key = |k: &str| refusal("input", json!({"type": "key", "documentId": DOC, "key": k}));
        assert_eq!(key("Enter"), None);
        assert_eq!(key(&"k".repeat(65)).as_deref(), Some("Browser key is invalid."));
    }

    #[test]
    fn a_composition_selection_stays_inside_its_text() {
        let comp = |start: i64, end: i64| {
            refusal("input", json!({"type": "composition", "documentId": DOC, "text": "abc", "selectionStart": start, "selectionEnd": end}))
        };
        assert_eq!(comp(1, 3), None);
        assert_eq!(comp(2, 1).as_deref(), Some("Browser selectionEnd is invalid."));
        assert_eq!(comp(0, 4).as_deref(), Some("Browser selectionEnd is invalid."));
        assert_eq!(refusal("input", json!({"type": "composition-end", "documentId": DOC, "text": "abc"})), None);
    }

    #[test]
    fn a_dialog_answer_needs_a_boolean_accept_a_request_id_and_known_options() {
        let answer = |patch: Value| {
            let mut input = json!({"type": "answer-dialog", "documentId": DOC, "accept": true, "requestId": "r1"});
            input.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            refusal("input", input)
        };
        assert_eq!(answer(json!({})), None);
        assert_eq!(answer(json!({"remember": "site"})), None);
        assert_eq!(answer(json!({"accept": "yes"})).as_deref(), Some("Browser dialog answer is invalid."));
        assert_eq!(answer(json!({"remember": "always"})).as_deref(), Some("Browser dialog answer is invalid."));
        assert_eq!(answer(json!({"keepDefault": 1})).as_deref(), Some("Browser dialog answer is invalid."));
        assert_eq!(answer(json!({"requestId": ""})).as_deref(), Some("Browser requestId is invalid."));
    }

    #[test]
    fn a_page_release_names_a_main_browser_page() {
        assert_eq!(refusal("release", json!({"id": "main-browser-abc_1-2"})), None);
        for bad in [json!({"id": "other"}), json!({"id": "main-browser-a b"}), json!({})] {
            assert_eq!(refusal("release", bad).as_deref(), Some("Browser page is not a main tab page."));
        }
    }

    #[test]
    fn a_history_query_is_at_most_five_hundred_units() {
        assert_eq!(refusal("history", json!({"query": "q".repeat(500)})), None);
        assert_eq!(refusal("history", json!({"query": "q".repeat(501)})).as_deref(), Some("Browser history query is invalid."));
        assert_eq!(refusal("history", json!({})).as_deref(), Some("Browser history query is invalid."));
    }

    #[test]
    fn an_import_names_a_job_a_source_a_profile_and_one_to_three_known_items() {
        let import = |patch: Value| {
            let mut input = json!({"jobId": "job-12345", "sourceId": "chrome", "profileId": "Default", "items": ["passwords", "cookies"]});
            input.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            refusal("importStart", input)
        };
        assert_eq!(import(json!({})), None);
        assert_eq!(import(json!({"jobId": "short"})).as_deref(), Some("Browser import job id is invalid."));
        assert_eq!(import(json!({"jobId": "has space 123"})).as_deref(), Some("Browser import job id is invalid."));
        assert_eq!(import(json!({"sourceId": ""})).as_deref(), Some("Browser import source id is invalid."));
        assert_eq!(import(json!({"profileId": "p".repeat(201)})).as_deref(), Some("Browser import profile id is invalid."));
        assert_eq!(import(json!({"items": []})).as_deref(), Some("Browser import items are invalid."));
        assert_eq!(import(json!({"items": ["passwords", "cookies", "history", "passwords"]})).as_deref(), Some("Browser import items are invalid."));
        assert_eq!(import(json!({"items": ["bookmarks"]})).as_deref(), Some("Browser import items are invalid."));
    }

    #[test]
    fn a_stored_credential_is_named_by_twenty_four_lower_case_hex_digits() {
        let fill = |id: &str| refusal("credentialFill", json!({"session_id": "s", "credentialId": id}));
        assert_eq!(fill(&"a1".repeat(12)), None);
        assert_eq!(fill(&"A1".repeat(12)).as_deref(), Some("Stored browser credential id is invalid."));
        assert_eq!(fill("abc").as_deref(), Some("Stored browser credential id is invalid."));
    }
}
