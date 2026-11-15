//! Queued-message restore (`components/prompt-input/restore-policy.mjs`).
//!
//! A queue restore settles after the user may have kept editing. The session service is asked for queued text only; it is
//! prepended to the latest local draft, so a delayed response can never replace newer typing. Reclaimed queued commands go
//! before the current input and the caret keeps its place inside that input, also when a daemon-backed restore settles
//! after further local editing.

use mixdog_js::{js_trim, value_to_string};
use serde_json::Value;

use super::draft::Draft;
use super::editing::{len16, slice16_from};

/// The draft with `queued` text in front of the current draft (separated by a newline when both have text), the caret and
/// the selection anchor moved by the length of what was put in front.
pub fn merge_queued_restore_draft(queued: &str, current: &Draft) -> Draft {
    let include_queued = !js_trim(queued).is_empty();
    let include_current = !js_trim(&current.value).is_empty();
    let separator = if include_queued && include_current { "\n" } else { "" };
    let value = format!(
        "{}{}{}",
        if include_queued { queued } else { "" },
        separator,
        if include_current { current.value.as_str() } else { "" }
    );
    let prefix_length = if include_queued { len16(queued) + len16(separator) } else { 0 };
    let current_length = current.len16();
    let current_cursor = if include_current { current.cursor.min(current_length) } else { 0 };
    let selection_anchor = match current.selection_anchor {
        Some(anchor) if include_current => Some(prefix_length + anchor.min(current_length)),
        _ => None,
    };
    Draft { value, cursor: prefix_length + current_cursor, selection_anchor }
}

/// The queued entries a restore covers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QueuedRestoreProjection {
    pub count: usize,
    pub ids: Vec<String>,
    pub text: String,
}

/// `String(value)` of an entry field that is neither missing nor null.
fn field_string(entry: &Value, name: &str) -> Option<String> {
    entry.get(name).filter(|value| !value.is_null()).map(value_to_string)
}

/// The entries of the queue that `selected_id` picks (all of them when it is blank): how many, their ids, and their texts
/// (`displayText`, else `text`, else `prompt`) joined with newlines, blank texts left out.
pub fn queued_restore_projection(entries: &[Value], selected_id: &str) -> QueuedRestoreProjection {
    let target = js_trim(selected_id);
    let selected: Vec<&Value> = entries
        .iter()
        .filter(|entry| target.is_empty() || field_string(entry, "id").unwrap_or_default() == target)
        .collect();
    let ids = selected.iter().map(|entry| field_string(entry, "id").unwrap_or_default()).filter(|id| !id.is_empty());
    let text = selected
        .iter()
        .map(|entry| {
            field_string(entry, "displayText")
                .or_else(|| field_string(entry, "text"))
                .or_else(|| field_string(entry, "prompt"))
                .unwrap_or_default()
        })
        .filter(|text| !js_trim(text).is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    QueuedRestoreProjection { count: selected.len(), ids: ids.collect(), text }
}

/// The text a restore put in front of `current_text`.
pub fn queued_restore_prefix(queued: &str, current_text: &str) -> String {
    let merged = merge_queued_restore_draft(queued, &Draft::new(current_text, 0, None)).value;
    let tail = if js_trim(current_text).is_empty() { 0 } else { len16(current_text) };
    let keep = len16(&merged).saturating_sub(tail);
    super::editing::slice16(&merged, 0, keep).to_owned()
}

/// The draft after the optimistic prefix is swapped for the authoritative one, the caret and anchor remapped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplacedPrefix {
    pub draft: Draft,
    /// False when the draft no longer starts with the optimistic prefix and was left alone.
    pub replaced: bool,
}

pub fn replace_queued_restore_prefix(optimistic: &str, authoritative: &str, current: &Draft) -> ReplacedPrefix {
    if !optimistic.is_empty() && !current.value.starts_with(optimistic) {
        return ReplacedPrefix { draft: current.clone(), replaced: false };
    }
    let optimistic_length = len16(optimistic);
    let authoritative_length = len16(authoritative);
    let value = format!("{}{}", authoritative, slice16_from(&current.value, optimistic_length));
    let current_length = current.len16();
    let remap = |offset: usize| {
        let bounded = offset.min(current_length);
        if bounded <= optimistic_length { authoritative_length.min(bounded) } else { bounded + authoritative_length - optimistic_length }
    };
    ReplacedPrefix {
        draft: Draft { cursor: remap(current.cursor), selection_anchor: current.selection_anchor.map(remap), value },
        replaced: true,
    }
}

/// Whether the palette owns Up/Down (it has more than one option to move between).
pub fn palette_owns_prompt_vertical_arrow(option_count: i64) -> bool {
    option_count.max(0) > 1
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn queued_text_goes_before_the_current_draft_and_the_caret_keeps_its_place() {
        let merged = merge_queued_restore_draft("queued", &Draft::new("typing", 3, Some(1)));
        assert_eq!(merged, Draft::new("queued\ntyping", 10, Some(8)));
        assert_eq!(merge_queued_restore_draft("queued", &Draft::new("  ", 1, None)), Draft::new("queued", 6, None));
        assert_eq!(merge_queued_restore_draft("  ", &Draft::new("typing", 2, None)), Draft::new("typing", 2, None));
        assert_eq!(merge_queued_restore_draft("q", &Draft::new("ab", 9, Some(9))), Draft::new("q\nab", 4, Some(4)));
    }

    #[test]
    fn the_projection_counts_selected_entries_and_joins_their_texts() {
        let entries = vec![
            json!({"id": "a", "displayText": "first"}),
            json!({"id": 2, "text": "second", "prompt": "no"}),
            json!({"id": "c", "prompt": "  "}),
            json!({"id": "d", "prompt": "fourth"}),
        ];
        let all = queued_restore_projection(&entries, "");
        assert_eq!(all.count, 4);
        assert_eq!(all.ids, ["a", "2", "c", "d"]);
        assert_eq!(all.text, "first\nsecond\nfourth");
        let one = queued_restore_projection(&entries, " 2 ");
        assert_eq!((one.count, one.ids, one.text), (1, vec!["2".to_owned()], "second".to_owned()));
        assert_eq!(queued_restore_projection(&[], "").count, 0);
    }

    #[test]
    fn the_prefix_is_what_the_merge_put_in_front() {
        assert_eq!(queued_restore_prefix("queued", "typing"), "queued\n");
        assert_eq!(queued_restore_prefix("queued", ""), "queued");
        assert_eq!(queued_restore_prefix("", "typing"), "");
    }

    #[test]
    fn an_authoritative_prefix_replaces_the_optimistic_one() {
        let current = Draft::new("opt\nhello", 7, Some(2));
        let replaced = replace_queued_restore_prefix("opt\n", "authoritative\n", &current);
        assert!(replaced.replaced);
        assert_eq!(replaced.draft, Draft::new("authoritative\nhello", 17, Some(2)));
        let untouched = replace_queued_restore_prefix("opt\n", "x", &Draft::new("changed", 3, None));
        assert!(!untouched.replaced);
        assert_eq!(untouched.draft, Draft::new("changed", 3, None));
        let from_empty = replace_queued_restore_prefix("", "auth", &Draft::new("hi", 2, None));
        assert_eq!(from_empty.draft, Draft::new("authhi", 6, None));
    }

    #[test]
    fn the_palette_owns_up_and_down_with_more_than_one_option() {
        assert!(!palette_owns_prompt_vertical_arrow(0));
        assert!(!palette_owns_prompt_vertical_arrow(1));
        assert!(palette_owns_prompt_vertical_arrow(2));
        assert!(!palette_owns_prompt_vertical_arrow(-5));
    }
}
