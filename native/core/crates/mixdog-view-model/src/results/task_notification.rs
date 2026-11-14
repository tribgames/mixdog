//! The outer fields of a `<task-notification>` envelope (`parseTaskNotification` of `shared/task-notification-envelope.mjs`).
//! Scalar fields are escaped on the wire; the result text is verbatim and never searched for metadata, because it may itself
//! contain tags (including task notifications).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;

const HEAD: &str = "<task-notification>\n";
const TAIL: &str = "\n</task-notification>";
const RESULT_OPEN: &str = "\n<result>\n";
const RESULT_CLOSE: &str = "\n</result>";

static FIELD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^<([\w-]+)>([^<]*)</\1>$", "m"));
static SURFACE_WORD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\S+) task ", ""));
static EXIT_CODE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^-?\d+$", ""));

/// A parsed task notification.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskNotification {
    pub task_id: String,
    pub tag: String,
    pub surface: String,
    pub status: String,
    pub summary: String,
    pub result: String,
    pub error: String,
    pub exit_code: Option<f64>,
    pub output_file: String,
}

fn decode_field(value: &str) -> String {
    value.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// `parseTaskNotification`: the envelope's fields, or `None` for any other text.
pub fn parse_task_notification(text: &str) -> Option<TaskNotification> {
    let value = js_trim(text);
    if !value.starts_with(HEAD) || !value.ends_with(TAIL) || value.len() < HEAD.len() + TAIL.len() {
        return None;
    }
    let mut fields_text = value[HEAD.len()..value.len() - TAIL.len()].to_owned();
    let mut result = String::new();
    if let Some(start) = fields_text.find(RESULT_OPEN) {
        let end = fields_text.rfind(RESULT_CLOSE)?;
        if end < start {
            return None;
        }
        result = fields_text.get(start + RESULT_OPEN.len()..end).unwrap_or_default().to_owned();
        fields_text = format!("{}{}", &fields_text[..start], &fields_text[end + RESULT_CLOSE.len()..]);
    }
    let mut fields: Vec<(String, String)> = Vec::new();
    for found in FIELD.captures_iter(&fields_text) {
        let (Some(name), Some(raw)) = (found.get(1), found.get(2)) else { continue };
        let decoded = decode_field(raw);
        match fields.iter_mut().find(|(known, _)| known.as_str() == name) {
            Some(slot) => slot.1 = decoded,
            None => fields.push((name.to_owned(), decoded)),
        }
    }
    let get = |name: &str| fields.iter().find(|(known, _)| known.as_str() == name).map(|(_, value)| value.as_str()).unwrap_or_default();
    let (task_id, status, summary) = (get("task-id"), get("status"), get("summary"));
    if task_id.is_empty() || !matches!(status, "completed" | "failed" | "cancelled") || summary.is_empty() {
        return None;
    }
    let surface = if summary.starts_with("Agent \"") {
        "agent".to_owned()
    } else if summary.starts_with("Shell task ") {
        "shell".to_owned()
    } else {
        SURFACE_WORD.captures(summary).and_then(|found| found.get(1)).map_or_else(|| "tool".to_owned(), str::to_owned)
    };
    let exit = get("exit-code");
    Some(TaskNotification {
        task_id: task_id.to_owned(),
        tag: get("tag").to_owned(),
        surface,
        status: status.to_owned(),
        summary: summary.to_owned(),
        result,
        error: get("error").to_owned(),
        exit_code: EXIT_CODE.is_match(exit).then(|| string_to_number(exit)),
        output_file: get("output-file").to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_envelope_is_parsed() {
        let text = "<task-notification>\n<task-id>T-1</task-id>\n<status>completed</status>\n<exit-code>3</exit-code>\n<summary>Shell task completed (exit 3): a &amp; b</summary>\n<result>\nline <status>x</status>\n</result>\n</task-notification>";
        let parsed = parse_task_notification(&format!("  {text}\n")).expect("envelope");
        assert_eq!((parsed.task_id.as_str(), parsed.surface.as_str(), parsed.exit_code), ("T-1", "shell", Some(3.0)));
        assert_eq!(parsed.summary, "Shell task completed (exit 3): a & b");
        assert_eq!(parsed.result, "line <status>x</status>");
    }

    #[test]
    fn surfaces() {
        let envelope = |summary: &str| {
            format!("<task-notification>\n<task-id>1</task-id>\n<status>failed</status>\n<summary>{summary}</summary>\n<error>bad</error>\n</task-notification>")
        };
        assert_eq!(parse_task_notification(&envelope("Agent \"x\" failed: bad")).map(|n| n.surface), Some("agent".to_owned()));
        assert_eq!(parse_task_notification(&envelope("media task failed")).map(|n| n.surface), Some("media".to_owned()));
        assert_eq!(parse_task_notification(&envelope("oops")).map(|n| n.surface), Some("tool".to_owned()));
        assert_eq!(parse_task_notification(&envelope("x task failed")).map(|n| n.error), Some("bad".to_owned()));
    }

    #[test]
    fn anything_else_is_not_an_envelope() {
        assert!(parse_task_notification("plain").is_none());
        assert!(parse_task_notification("<task-notification>\n</task-notification>").is_none());
        assert!(parse_task_notification("<task-notification>\n<task-id>1</task-id>\n<status>weird</status>\n<summary>s</summary>\n</task-notification>").is_none());
        assert!(parse_task_notification("<task-notification>\n<task-id>1</task-id>\n<status>failed</status>\n<summary>s</summary>\n<result>\nopen\n</task-notification>").is_none());
    }
}
