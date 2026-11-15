//! `components/SignInUrl.jsx` and `components/sign-in-url-layout.mjs`: a sign-in URL shown outside any bordered panel.
//!
//! Inside a bordered panel a wrapped URL carries the border and the padding on every row, so a terminal selection
//! copies junk. Here the rows are plain text with no border, the URL is an OSC 8 hyperlink whose target is the complete
//! URL, and Ctrl+Y copies the exact URL. [`sign_in_url_layout`] may shorten the visible label to fit the rows the
//! panel can give; the link target and the copy stay complete.

use mixdog_js::js_trim;
use mixdog_term::input::KeyFlags;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_tui_style::Key;

use crate::panel_cell_text::truncate_panel_text;
use crate::text_layout::wrapped_detail_rows;
use crate::themed;

/// The one key that copies a sign-in URL in every panel, with or without a focused text input.
pub const SIGN_IN_COPY_KEY: &str = "Ctrl+Y";

/// What the last copy did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CopyStatus {
    #[default]
    Idle,
    Copied,
    /// Only an OSC 52 sequence went to the terminal: the terminal's clipboard was not confirmed.
    Sent,
    Failed,
}

/// How a copy reached a clipboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyMethod {
    /// Through the terminal (OSC 52).
    Terminal,
    /// Through the system clipboard.
    System,
}

/// `isSignInCopyKey(input, key)`.
pub fn is_sign_in_copy_key(input: &str, key: &KeyFlags) -> bool {
    key.ctrl && input.to_lowercase() == "y"
}

/// `signInUrlNote(status)`: the copy-key note, or what the last copy did.
pub fn sign_in_url_note(status: CopyStatus) -> String {
    match status {
        CopyStatus::Copied => "URL copied".to_owned(),
        CopyStatus::Sent => "Sent to terminal clipboard (not confirmed)".to_owned(),
        CopyStatus::Failed => "Copy failed: no clipboard available, use the link above".to_owned(),
        CopyStatus::Idle => format!("{SIGN_IN_COPY_KEY} copies the full URL"),
    }
}

/// `useCopyUrl(url, copyText).copy`: copies the URL through `copy` and says what the status becomes. A blank URL
/// copies nothing and leaves the status as it is.
pub fn copy_url(url: &str, copy: impl FnOnce(&str) -> Result<CopyMethod, String>) -> Option<CopyStatus> {
    if url.is_empty() {
        return None;
    }
    Some(match copy(url) {
        Ok(CopyMethod::Terminal) => CopyStatus::Sent,
        Ok(CopyMethod::System) => CopyStatus::Copied,
        Err(_) => CopyStatus::Failed,
    })
}

/// The row budget of a borderless URL block (`signInUrlLayout`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignInUrlLayout {
    pub compact: bool,
    pub rows: usize,
    pub hint: bool,
    pub label: String,
}

/// `signInUrlLayout(url, columns, maxRows)`: `max_rows` is the height the panel can give the block (`i64::MAX` when
/// unbounded). The block degrades until it fits and only the visible text shrinks:
/// 1. the full URL wrapped over its rows and a copy-hint row;
/// 2. one row with the start of the URL and `…`, and the hint row;
/// 3. that one row alone;
/// 4. nothing (the panel's own description row carries the copy note).
pub fn sign_in_url_layout(url: &str, columns: usize, max_rows: i64) -> SignInUrlLayout {
    let text = js_trim(url);
    if text.is_empty() {
        return SignInUrlLayout { compact: false, rows: 0, hint: false, label: String::new() };
    }
    let width = columns.max(1);
    let max = max_rows.max(0) as u64;
    let full_rows = wrapped_detail_rows(text, width) + 1;
    if full_rows as u64 <= max {
        return SignInUrlLayout { compact: false, rows: full_rows, hint: true, label: text.to_owned() };
    }
    let label = truncate_panel_text(text, width);
    if max >= 2 {
        return SignInUrlLayout { compact: true, rows: 2, hint: true, label };
    }
    if max >= 1 {
        return SignInUrlLayout { compact: true, rows: 1, hint: false, label };
    }
    SignInUrlLayout { compact: true, rows: 0, hint: false, label: String::new() }
}

/// `linkedUrl(url, label)`: an OSC 8 hyperlink needs no support probe (a terminal that does not know it shows the
/// label); only http(s) targets are linked.
fn linked_url(url: &str, label: &str) -> String {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        format!("\x1b]8;;{url}\x07{label}\x1b]8;;\x07")
    } else {
        label.to_owned()
    }
}

/// Paints the URL block at `(x, y)` in `width` cells and returns the rows it took (none for a blank URL or a layout
/// without rows).
pub fn paint_sign_in_url(
    painter: &mut Painter,
    x: i32,
    y: i32,
    width: usize,
    url: &str,
    layout: &SignInUrlLayout,
    status: CopyStatus,
) -> u16 {
    let text = js_trim(url);
    if text.is_empty() || layout.rows == 0 {
        return 0;
    }
    let mode = if layout.compact { TextWrap::TruncateEnd } else { TextWrap::Wrap };
    let mut rows = painter.text(x, y, &linked_url(text, &layout.label), themed(Key::Text), width, mode);
    if layout.hint {
        painter.text(x, y + i32::from(rows), &sign_in_url_note(status), themed(Key::Subtle), width, TextWrap::TruncateEnd);
        rows += 1;
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.com/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A1455";

    #[test]
    fn the_layout_degrades_step_by_step_and_only_the_label_shrinks() {
        let full = sign_in_url_layout(URL, 40, 10);
        assert!(!full.compact && full.hint && full.label == URL && full.rows == wrapped_detail_rows(URL, 40) + 1);
        let hinted = sign_in_url_layout(URL, 40, 2);
        assert_eq!((hinted.compact, hinted.rows, hinted.hint), (true, 2, true));
        assert!(hinted.label.ends_with('\u{2026}'));
        let bare = sign_in_url_layout(URL, 40, 1);
        assert_eq!((bare.compact, bare.rows, bare.hint), (true, 1, false));
        let none = sign_in_url_layout(URL, 40, 0);
        assert_eq!((none.rows, none.label.as_str()), (0, ""));
        assert_eq!(sign_in_url_layout("  ", 40, 5).rows, 0);
        assert_eq!(sign_in_url_layout(URL, 40, -3).rows, 0);
    }

    #[test]
    fn only_http_targets_are_linked() {
        assert_eq!(linked_url("https://a.b/", "x"), "\x1b]8;;https://a.b/\x07x\x1b]8;;\x07");
        assert_eq!(linked_url("ftp://a.b/", "x"), "x");
    }

    #[test]
    fn a_copy_reports_what_reached_the_clipboard() {
        assert_eq!(copy_url("u", |_| Ok(CopyMethod::Terminal)), Some(CopyStatus::Sent));
        assert_eq!(copy_url("u", |_| Ok(CopyMethod::System)), Some(CopyStatus::Copied));
        assert_eq!(copy_url("u", |_| Err("none".to_owned())), Some(CopyStatus::Failed));
        assert_eq!(copy_url("", |_| Ok(CopyMethod::System)), None);
        assert!(is_sign_in_copy_key("Y", &KeyFlags { ctrl: true, ..KeyFlags::default() }));
        assert!(!is_sign_in_copy_key("y", &KeyFlags::default()));
    }
}
