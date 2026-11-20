//! `plainPreviewText` (`src/runtime/shared/plain-preview.mjs`): a messenger preview line reads as
//! plain text, as KakaoTalk shows it: the markdown a reply was written in (bold, headings, list
//! markers, quotes, code fences and spans, links, images) is dropped, its words kept.

use std::sync::LazyLock;

use mixdog_js::{Caps, JsRegex, js_trim, slice_utf16};

/// A safety cap only: the row clamps the shown text to two lines.
const PREVIEW_CAP: usize = 200;

/// One `.replace(/pattern/flags, replacement)` of the chain.
struct Step {
    pattern: JsRegex,
    with: fn(&Caps) -> String,
}

fn group(caps: &Caps, index: usize) -> String {
    caps.get(index).unwrap_or("").to_owned()
}

fn nothing(_: &Caps) -> String {
    String::new()
}

fn space(_: &Caps) -> String {
    " ".to_owned()
}

fn first(caps: &Caps) -> String {
    group(caps, 1)
}

fn second(caps: &Caps) -> String {
    group(caps, 2)
}

fn first_second(caps: &Caps) -> String {
    format!("{}{}", group(caps, 1), group(caps, 2))
}

fn first_then_space(caps: &Caps) -> String {
    format!("{} ", group(caps, 1))
}

fn step(pattern: &str, flags: &str, with: fn(&Caps) -> String) -> Step {
    Step { pattern: JsRegex::new_static(pattern, flags), with }
}

static STEPS: LazyLock<Vec<Step>> = LazyLock::new(|| {
    vec![
        // HTML comments never show in markdown (a greeting's suggestions ride one).
        step(r"<!--[\s\S]*?(?:-->|$)", "g", space),
        step(r"^[ \t]*(`{3,}|~{3,})[^\n]*$", "gm", space),
        step(r"!\[([^\]]*)\]\([^)]*\)", "g", first),
        step(r"\[([^\]]+)\]\([^)]*\)", "g", first),
        step(r"^[ \t]{0,3}#{1,6}[ \t]+", "gm", nothing),
        step(r"^[ \t]*>[ \t]?", "gm", nothing),
        step(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?", "gm", nothing),
        step(r"^[ \t]*(?:[-*_][ \t]*){3,}$", "gm", space),
        step(r"(\*\*|__)(?=\S)([\s\S]*?\S)\1", "g", second),
        step(r"(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)", "g", first_second),
        step(r"(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)", "g", first_second),
        step(r"~~(?=\S)([\s\S]*?\S)~~", "g", first),
        step(r"`+([^`\n]*)`+", "g", first),
        step(r"\s+", "g", space),
        // A summary stored before newlines were kept already folded its list: a dash or bullet
        // right after a sentence end is a marker, not a hyphen.
        step(r"([.!?。…:：])\s[-*+•]\s+(?=\S)", "g", first_then_space),
    ]
});

/// `text` without markdown syntax, whitespace folded to single spaces.
pub fn plain_preview_text(text: &str) -> String {
    let mut out = text.to_owned();
    for step in STEPS.iter() {
        out = step.pattern.replace_all_with(&out, step.with);
    }
    slice_utf16(js_trim(&out), PREVIEW_CAP)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const GOLDEN: &str = include_str!("preview/golden.json");

    #[test]
    fn every_recorded_preview_equals_node() {
        let golden: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
        assert!(golden.len() > 20);
        for case in golden {
            let input = case["input"].as_str().unwrap();
            assert_eq!(plain_preview_text(input), case["out"].as_str().unwrap(), "{input:?}");
        }
    }
}
