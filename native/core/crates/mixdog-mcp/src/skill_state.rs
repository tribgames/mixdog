//! Whether a skill's instructions are still in the conversation the model sees (Node
//! `skill-state.mjs` and `skillBodyPresentInSession`). The live transcript is the authority:
//! the check matches the full current body, so edited skills and skills dropped by compaction
//! are delivered again.

use mixdog_js::JsRegex;
use mixdog_js::js_trim_start;
use serde_json::Value;

/// The text of a message `content`: a string as is, an array's blocks joined, anything else
/// empty.
pub fn message_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| match block {
                Value::String(s) => s.clone(),
                other => other.get("text").filter(|t| !t.is_null() && t.as_str() != Some("")).map_or_else(String::new, mixdog_js::value_to_string),
            })
            .collect(),
        _ => String::new(),
    }
}

fn unescape(name: &str) -> String {
    JsRegex::new_static("&(amp|lt|gt|quot|apos);", "g").replace_all_with(name, |caps| {
        let replacement = match caps.get(1).unwrap_or_default() {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            _ => "'",
        };
        replacement.to_owned()
    })
}

/// The skill name of an injected `<skill>` message, or `None` when the text is not one.
fn injected_name(text: &str) -> Option<String> {
    let pattern = JsRegex::new_static(r"^<skill>\n<name>([^<\n]+)</name>\n[\s\S]*\n</skill>$", "");
    pattern.captures(text).and_then(|caps| caps.get(1)).map(unescape)
}

/// Whether the latest injected message of the skill `body` names is exactly `body`.
/// `user_texts` are the texts of the live transcript's user messages, oldest first.
pub fn body_present<I>(user_texts: I, body: &str) -> bool
where
    I: IntoIterator<Item = String>,
{
    if body.is_empty() {
        return false;
    }
    let Some(requested) = injected_name(js_trim_start(body)) else { return false };
    let mut latest: Option<String> = None;
    for text in user_texts {
        let trimmed = js_trim_start(&text);
        if injected_name(trimmed).as_deref() == Some(requested.as_str()) {
            latest = Some(trimmed.to_owned());
        }
    }
    latest.is_some_and(|text| text == body)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn skill(name: &str, body: &str) -> String {
        format!("<skill>\n<name>{name}</name>\n{body}\n</skill>")
    }

    #[test]
    fn only_the_latest_identical_body_counts_as_present() {
        let v1 = skill("demo", "one");
        let v2 = skill("demo", "two");
        assert!(body_present(vec!["hi".to_owned(), format!("\n {v1}")], &v1));
        assert!(!body_present(vec![v1.clone(), v2.clone()], &v1), "a newer body supersedes");
        assert!(body_present(vec![v1.clone(), v2.clone()], &v2));
        assert!(!body_present(Vec::<String>::new(), &v1), "compacted away");
        assert!(!body_present(vec![skill("other", "one")], &v1));
        assert!(!body_present(vec![v1.clone()], "not a skill"));
    }

    #[test]
    fn escaped_names_are_matched_unescaped() {
        let body = skill("a&lt;b", "x");
        assert!(body_present(vec![skill("a&lt;b", "x")], &body));
    }

    #[test]
    fn block_content_joins_its_text() {
        assert_eq!(message_text(&json!([{"text": "a"}, "b", {"type": "image"}])), "ab");
        assert_eq!(message_text(&json!(3)), "");
    }
}
