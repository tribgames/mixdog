//! Ctrl+C selection copy (`use-copy-selection.mjs`). It merges the three harvest sources: the current render's visible
//! selection, the text remembered while the selection was last fully painted and the cross-scroll stitch buffer (only when it
//! is contiguous). While nothing is found it retries briefly as the renderer refreshes, and it reports through the prompt hint
//! band. The clipboard write is the terminal layer's (`mixdog_term::clipboard::copy_to_clipboard`) through the host.

use mixdog_js::js_trim;

use super::host::HintTone;
use super::{Mouse, MouseHost};

/// How many times an empty copy is tried again before it says there is nothing to copy.
const MAX_RETRIES: u32 = 4;
/// The wait before the retry that follows a retry (the first retry is immediate).
const RETRY_DELAY_MS: u64 = 24;

/// A copy that found nothing yet and is tried again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct CopyRetry {
    pub(super) at_ms: u64,
    attempt: u32,
}

/// The length of `text` as JavaScript counts it (UTF-16 code units).
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

impl Mouse {
    /// `copySelection(attempt)`: copies the selection, merged from the render, the remembered text and the stitch buffer.
    /// Ctrl+C is swallowed by the caller either way; the outcome is a hint in the prompt hint band. An empty first try is
    /// scheduled again through [`Self::tick`].
    pub fn copy_selection<H: MouseHost + ?Sized>(&mut self, host: &mut H, attempt: u32, now_ms: u64) {
        self.copy_retry = None;
        let rendered = host.render_selection_text();
        // A selection that partly scrolled out of the viewport renders, and so harvests, only its visible rows. The remembered
        // text, captured while it was last fully painted, is the fuller copy: the longer wins, so scrolling never shrinks a copy.
        let mut text = self.selection_text.clone();
        if let Some(rendered) = rendered {
            if js_length(&rendered) >= js_length(&text) {
                text = rendered;
            }
        }
        // The stitch buffer reconstructs rows that scrolled out of view entirely, which neither of the other two ever saw. It
        // is preferred only when it covers the selection contiguously and adds rows: a gapped stitch silently drops a
        // scrolled-off row.
        let stitched = self.stitched_selection_text(host.scroll_target());
        if stitched.complete && js_length(&stitched.text) > js_length(&text) {
            text = stitched.text;
        }
        if js_trim(&text).is_empty() {
            if attempt < MAX_RETRIES {
                let wait = if attempt == 0 { 0 } else { RETRY_DELAY_MS };
                self.copy_retry = Some(CopyRetry { at_ms: now_ms.saturating_add(wait), attempt: attempt + 1 });
                return;
            }
            // Retries exhausted with nothing to copy: never return silently, the user pressed Ctrl+C expecting feedback.
            host.show_selection_copy_hint("nothing to copy \u{b7} select text first", HintTone::Error);
            return;
        }
        self.selection_text.clone_from(&text);
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

    pub(super) fn copy_retry_tick<H: MouseHost + ?Sized>(&mut self, host: &mut H, now_ms: u64) {
        if let Some(retry) = self.copy_retry.filter(|retry| now_ms >= retry.at_ms) {
            self.copy_selection(host, retry.attempt, now_ms);
        }
    }
}
