//! `portable/placeholder-scan.mjs`: wording only a template or a tool leaves behind; a deliverable never carries it. One
//! list serves every format with visible text: slides, a document's body, headers and footers, and the pages of a PDF.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, slice_utf16};
use serde_json::{Map, Value};

use crate::xml::TEMPLATE_TOKEN_SOURCE;

struct Rule {
    code: &'static str,
    label: &'static str,
    pattern: JsRegex,
}

fn rule(code: &'static str, label: &'static str, source: &str, flags: &str) -> Rule {
    Rule { code, label, pattern: JsRegex::new_static(source, flags) }
}

static PLACEHOLDER_RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        rule("placeholder_text", "lorem ipsum filler", r"\b(?:lorem|ipsum)\b", "i"),
        rule("placeholder_text", "repeated X placeholder", r"\bx{3,}\b", "i"),
        rule("placeholder_text", "TODO marker", r"\bTODO\b", ""),
        rule("placeholder_text", "insert marker", r"\[\s*insert\b", "i"),
        rule("placeholder_text", "layout instruction", r"this[^.]{0,40}\b(?:page|slide)\b[^.]{0,40}layout", "i"),
        rule("placeholder_text", "click-to-edit prompt", r"click to (?:edit|add)", "i"),
        rule("placeholder_text", "Korean input prompt", r"(?:여기에|내용을|제목을)\s*입력", ""),
        // A value that reached the page as an object: no author types this, and it shipped as a slide title while the
        // measured read reported only the overlap the oversized string caused. Bracketed forms only: "undefined" and "NaN"
        // are words a technical document may mean.
        rule("placeholder_text", "stringified value", r"\[object [A-Z]\w*\]", ""),
        // A search or file tool's citation marker copied into the copy instead of a readable source: the reader meets
        // brackets and ids, never the reference.
        rule(
            "placeholder_text",
            "tool citation token",
            r"【[^】\n]{0,80}†[^】\n]{0,80}】|turn\d+(?:search|view|news|image|file|fetch|product)\d+|[-]|<\/?cite\b[^>]*>",
            "u",
        ),
        rule("unfilled_token", "unresolved template token", TEMPLATE_TOKEN_SOURCE, "u"),
    ]
});

/// `placeholderTextIssues(text, path, extra)`: one warning per rule the text trips, anchored at `path`; `extra` is merged
/// into each issue after `path`. An issue is `{ severity, code, path, ...extra, message, source }`.
pub fn placeholder_text_issues(text: &str, path: &str, extra: &Map<String, Value>) -> Vec<Value> {
    let mut issues = Vec::new();
    if js_trim(text).is_empty() {
        return issues;
    }
    for rule in PLACEHOLDER_RULES.iter() {
        let Some(found) = rule.pattern.find(text) else { continue };
        let mut issue = Map::new();
        issue.insert("severity".to_owned(), Value::from("warning"));
        issue.insert("code".to_owned(), Value::from(rule.code));
        issue.insert("path".to_owned(), Value::from(path));
        for (key, value) in extra {
            issue.insert(key.clone(), value.clone());
        }
        issue.insert("message".to_owned(), Value::from(format!("Leftover {}: \"{}\"", rule.label, slice_utf16(&text[found], 60))));
        issue.insert("source".to_owned(), Value::from("placeholder-scan"));
        issues.push(Value::Object(issue));
    }
    issues
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn issues(text: &str) -> Vec<(String, String)> {
        placeholder_text_issues(text, "/slide[1]", &Map::new())
            .iter()
            .map(|issue| (issue["code"].as_str().unwrap_or("").to_owned(), issue["message"].as_str().unwrap_or("").to_owned()))
            .collect()
    }

    #[test]
    fn each_leftover_is_named_with_what_was_found() {
        assert_eq!(issues("Lorem ipsum dolor"), [("placeholder_text".into(), "Leftover lorem ipsum filler: \"Lorem\"".into())]);
        assert_eq!(issues("XXXX here")[0].1, "Leftover repeated X placeholder: \"XXXX\"");
        assert_eq!(issues("TODO: fix")[0].1, "Leftover TODO marker: \"TODO\"");
        assert_eq!(issues("a [ Insert name]")[0].1, "Leftover insert marker: \"[ Insert\"");
        assert_eq!(issues("This is the slide title layout")[0].1, "Leftover layout instruction: \"This is the slide title layout\"");
        assert_eq!(issues("Click to edit Master")[0].1, "Leftover click-to-edit prompt: \"Click to edit\"");
        assert_eq!(issues("제목을 입력")[0].1, "Leftover Korean input prompt: \"제목을 입력\"");
        assert_eq!(issues("[object Object]")[0].1, "Leftover stringified value: \"[object Object]\"");
        assert_eq!(issues("see 【4†source】")[0].1, "Leftover tool citation token: \"【4†source】\"");
        assert_eq!(issues("turn0search1 and <cite>")[0].1, "Leftover tool citation token: \"turn0search1\"");
        assert_eq!(issues("Dear {{ 이름 }}"), [("unfilled_token".into(), "Leftover unresolved template token: \"{{ 이름 }}\"".into())]);
    }

    #[test]
    fn clean_and_blank_text_has_no_issue_and_a_text_can_trip_several_rules() {
        assert!(issues("A quarterly review").is_empty());
        assert!(issues("   ").is_empty());
        assert!(issues("undefined and NaN").is_empty());
        assert_eq!(issues("TODO {{x}}").iter().map(|(code, _)| code.as_str()).collect::<Vec<_>>(), ["placeholder_text", "unfilled_token"]);
    }

    #[test]
    fn extra_fields_sit_between_the_path_and_the_message() {
        let extra = json!({ "slide": 3 }).as_object().cloned().unwrap_or_default();
        let found = placeholder_text_issues("TODO", "/slide[3]", &extra);
        let keys: Vec<&str> = found[0].as_object().map(|issue| issue.keys().map(String::as_str).collect()).unwrap_or_default();
        assert_eq!(keys, ["severity", "code", "path", "slide", "message", "source"]);
        assert_eq!(found[0]["severity"], "warning");
        assert_eq!(found[0]["source"], "placeholder-scan");
    }

    #[test]
    fn the_found_text_is_cut_at_sixty_units() {
        let wide = format!("[object {}]", "A".repeat(80));
        let message = &issues(&wide)[0].1;
        assert_eq!(message.chars().count(), "Leftover stringified value: \"\"".chars().count() + 60);
    }
}
