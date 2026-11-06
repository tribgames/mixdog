//! `compactSessionTitle` and the title timeout of `runtime-core/session-title.mjs`: the one-line
//! label a Goal (or session) gets from a title model's answer or from its objective.

use mixdog_js::{JsRegex, js_trim, js_trim_end, utf16_len};
use mixdog_store::title::clean_session_preview;
use unicode_segmentation::UnicodeSegmentation;

pub const SESSION_TITLE_TIMEOUT_MS: u64 = 10_000;

fn meaningful(text: &str) -> bool {
    text.chars().any(|c| c.is_alphanumeric())
}

/// The longest prefix within `limit` UTF-16 units that ends on a grapheme boundary.
fn prefix_within(text: &str, limit: usize) -> String {
    let mut head = String::new();
    let mut used = 0;
    for piece in text.graphemes(true) {
        let len = utf16_len(piece);
        if used + len > limit {
            break;
        }
        head.push_str(piece);
        used += len;
    }
    head
}

/// `compactSessionTitle(value, 32)`.
pub fn compact_session_title(value: &str) -> String {
    compact_with(value, 32)
}

pub fn compact_with(value: &str, maximum: usize) -> String {
    static THINK: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    static EDGES: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    let think = THINK.get_or_init(|| JsRegex::new_static(r"<think>[\s\S]*?</think>\s*", "gi"));
    let edges = EDGES.get_or_init(|| JsRegex::new_static(r#"^["'`#*\s]+|["'`\s.]+$"#, "g"));
    let stripped = think.replace_all_with(value, |_| String::new());
    let line = stripped
        .split('\n')
        .map(|part| part.strip_suffix('\r').unwrap_or(part))
        .map(|entry| edges.replace_all_with(js_trim(entry), |_| String::new()))
        .find(|entry| !entry.is_empty())
        .unwrap_or_default();
    let text = clean_session_preview(&line, (maximum * 4).max(128));
    if !meaningful(&text) {
        return String::new();
    }
    if utf16_len(&text) <= maximum {
        return text;
    }
    let clipped = prefix_within(&text, maximum - 1);
    let boundary = clipped.encode_utf16().collect::<Vec<_>>().iter().rposition(|u| *u == 0x20);
    let head = match boundary {
        Some(at) if at >= (maximum as f64 * 0.6).floor() as usize => {
            String::from_utf16_lossy(&clipped.encode_utf16().take(at).collect::<Vec<_>>())
        }
        _ => clipped,
    };
    format!("{}…", js_trim_end(&head))
}
