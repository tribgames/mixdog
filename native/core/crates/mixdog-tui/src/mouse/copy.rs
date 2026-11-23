//! Ctrl+C selection copy (`use-copy-selection.mjs`). The text is the selection's own ([`Mouse::selected_text`]): what its
//! content read when it was made, which nothing reads again. The outcome is reported through the prompt hint band; the
//! clipboard write is the terminal layer's (`mixdog_term::clipboard::copy_to_clipboard`) through the host.

use mixdog_js::js_trim;

use super::host::HintTone;
use super::{Mouse, MouseHost};

/// The length of `text` as JavaScript counts it (UTF-16 code units).
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

impl Mouse {
    /// `copySelection`: copies the selection. Ctrl+C is swallowed by the caller either way; the outcome is a hint in the
    /// prompt hint band, and a selection with no text says so.
    pub fn copy_selection<H: MouseHost + ?Sized>(&mut self, host: &mut H) {
        let text = self.selected_text().unwrap_or_default();
        if js_trim(&text).is_empty() {
            host.show_selection_copy_hint("nothing to copy \u{b7} select text first", HintTone::Error);
            return;
        }
        match host.write_clipboard(&text) {
            Ok(()) => {
                let lines = text.split('\n').count();
                let chars = js_length(&text);
                let plural = if chars == 1 { "" } else { "s" };
                let line_note = if lines > 1 { format!(" \u{b7} {lines} lines") } else { String::new() };
                host.show_selection_copy_hint(&format!("copied {chars} char{plural}{line_note}"), HintTone::Plain);
            }
            Err(message) => host.show_selection_copy_hint(&format!("copy failed: {message}"), HintTone::Error),
        }
    }
}
