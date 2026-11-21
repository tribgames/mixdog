use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use serde_json::Value;

/// A catalog page: its rows and the service's own cursor to the next one.
pub struct ListPage {
    pub sessions: Vec<Value>,
    pub next_cursor: Option<String>,
}

/// `truncateToolText(value, max)`: trimmed, and cut to `max` UTF-16 units with `...` after it.
pub(super) fn truncate_tool_text(value: &str, max: usize) -> String {
    let text = js_trim(value);
    if utf16_len(text) > max { format!("{}...", slice_utf16(text, max)) } else { text.to_owned() }
}
