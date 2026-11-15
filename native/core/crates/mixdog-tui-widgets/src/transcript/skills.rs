//! `components/user-message-skills.mjs`: the skills a user row applied. The row marks the `$name` tokens of exactly those
//! skills (found by the shared mention parser) and adds one applied-skills line under the text.

use mixdog_view_model::display::skill_mentions::skill_mentions;
use serde_json::Value;

/// A stretch of a user text: plain, or the `$name` of an applied skill.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub mention: bool,
}

/// The applied skill names of a row value: non-empty strings only.
fn applied_skill_names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).filter(|name| !name.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// `appliedSkillsLine(value)`: the line rendered under a user row, empty when it applied no skill.
pub fn applied_skills_line(value: Option<&Value>) -> String {
    let names = applied_skill_names(value);
    if names.is_empty() { String::new() } else { format!("Skills applied: {}", names.join(", ")) }
}

/// The byte offset of the UTF-16 offset `units` in `text` (the mention parser counts UTF-16 units).
fn byte_of_utf16(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (at, ch) in text.char_indices() {
        if seen >= units {
            return at;
        }
        seen += ch.len_utf16();
    }
    text.len()
}

/// `userTextSegments(text, value)`: `text` split into plain and marked spans; only `$name` tokens of applied skills are
/// marked, so unknown names, `$HOME` and `$300` stay plain.
pub fn user_text_segments(text: &str, value: Option<&Value>) -> Vec<Segment> {
    let applied = applied_skill_names(value);
    if applied.is_empty() {
        return vec![Segment { text: text.to_owned(), mention: false }];
    }
    let mut segments = Vec::new();
    let mut at = 0;
    for mention in skill_mentions(text, |name| applied.iter().any(|applied| applied == name)) {
        let (start, end) = (byte_of_utf16(text, mention.start), byte_of_utf16(text, mention.end));
        if start > at {
            segments.push(Segment { text: text[at..start].to_owned(), mention: false });
        }
        segments.push(Segment { text: text[start..end].to_owned(), mention: true });
        at = end;
    }
    if at < text.len() || segments.is_empty() {
        segments.push(Segment { text: text[at..].to_owned(), mention: false });
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_line_lists_the_applied_names_and_skips_what_is_not_a_name() {
        assert_eq!(applied_skills_line(Some(&json!(["a", "b"]))), "Skills applied: a, b");
        assert_eq!(applied_skills_line(Some(&json!(["", 3, null, "c"]))), "Skills applied: c");
        assert_eq!(applied_skills_line(Some(&json!([]))), "");
        assert_eq!(applied_skills_line(Some(&json!("a"))), "");
        assert_eq!(applied_skills_line(None), "");
    }

    #[test]
    fn only_the_tokens_of_applied_skills_are_marked() {
        let text = "Use $api-review, not $pptx or `$api-review`; path $HOME, $300.";
        let segments = user_text_segments(text, Some(&json!(["api-review"])));
        let marked: Vec<&str> = segments.iter().filter(|segment| segment.mention).map(|segment| segment.text.as_str()).collect();
        assert_eq!(marked, ["$api-review"]);
        assert_eq!(segments.iter().map(|segment| segment.text.as_str()).collect::<String>(), text);
    }

    #[test]
    fn without_applied_skills_the_text_is_one_plain_segment() {
        assert_eq!(user_text_segments("a $b", None), [Segment { text: "a $b".to_owned(), mention: false }]);
        assert_eq!(user_text_segments("", Some(&json!(["b"]))), [Segment { text: String::new(), mention: false }]);
    }

    #[test]
    fn offsets_count_utf16_units() {
        let segments = user_text_segments("\u{1f600} $b!", Some(&json!(["b"])));
        assert_eq!(segments.iter().filter(|segment| segment.mention).count(), 1);
        assert_eq!(segments[0].text, "\u{1f600} ");
        assert_eq!(segments[1].text, "$b");
        assert_eq!(segments[2].text, "!");
    }
}
