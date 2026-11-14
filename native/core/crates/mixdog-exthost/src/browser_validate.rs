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
            if id.starts_with(MAIN_BROWSER_PAGE_PREFIX)
                && len16(id) <= 256
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
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

    /// The corpus the desktop's `remote-browser.test.mjs` reads too: each row is a UI action
    /// with its input and the text the desktop refuses it with (`null`: admitted).
    #[test]
    fn the_corpus_is_refused_with_the_desktops_text() {
        let corpus: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/browser-parity/remote-browser.json"))).unwrap();
        let rows = corpus["rows"].as_array().unwrap();
        assert!(rows.len() > 100);
        for row in rows {
            let mut input = row.get("input").cloned().unwrap_or(Value::Null);
            let answer = validate_ui_action(row["action"].as_str().unwrap(), &mut input);
            let message = match answer {
                Ok(()) => None,
                Err(CoreError::DomainError { domain, code: None, message, detail: None }) => {
                    assert_eq!(&*domain, "browser");
                    message.map(|m| m.to_string())
                }
                Err(other) => panic!("{row}: {other:?}"),
            };
            assert_eq!(message.as_deref(), row["error"].as_str(), "{row}");
        }
    }

    #[test]
    fn a_tool_action_and_an_empty_input_are_not_refused_here() {
        assert!(validate_ui_action("navigate", &mut Value::Null).is_ok());
        assert!(validate_ui_action("importSources", &mut json!({})).is_ok());
        assert!(validate_ui_action("history", &mut json!("x")).is_ok(), "the host answers a non-object input");
        assert!(validate_ui_action("importStart", &mut json!([1])).is_ok(), "the host answers an array input");
        let Err(CoreError::DomainError { message, .. }) = validate_ui_action("input", &mut Value::Null) else { panic!("refused") };
        assert_eq!(message.as_deref(), Some("unknown remote browser control \"(none)\"."));
    }
}
