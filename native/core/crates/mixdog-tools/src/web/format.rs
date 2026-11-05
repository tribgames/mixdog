//! Model-facing text for the web tools. Offsets and lengths are in UTF-16 code
//! units, the unit the tools have always reported.

use super::pipeline::Attempt;
use super::pipeline::Failure;

pub const DEFAULT_FETCH_MAX_LENGTH: u64 = 20_000;

/// A page window.
#[derive(Clone, Debug)]
pub struct Window {
    pub content: String,
    pub bytes: usize,
    pub total_length: u64,
    pub start: u64,
    pub end: u64,
    pub has_more: bool,
    pub next_start: Option<u64>,
    /// The default length (not an explicit one) cut the page.
    pub capped: bool,
}

pub enum FetchItem {
    Success {
        url: String,
        title: String,
        window: Window,
        failures: Vec<Failure>,
        attempts: Vec<Attempt>,
    },
    Error {
        url: String,
        error: String,
        error_code: String,
        failures: Vec<Failure>,
        attempts: Vec<Attempt>,
    },
}

/// `text[start..end]` in UTF-16 units; a window edge inside a surrogate pair
/// becomes U+FFFD.
fn slice_utf16(text: &str, start: usize, end: usize) -> String {
    if text.is_ascii() {
        return text[start..end].to_string();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[start..end])
}

fn utf16_length(text: &str) -> usize {
    if text.is_ascii() {
        text.len()
    } else {
        text.encode_utf16().count()
    }
}

fn is_high(unit: u16) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}

fn is_low(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

pub fn clip(text: &str, cap: usize) -> String {
    if utf16_length(text) > cap {
        format!("{}…", slice_utf16(text, 0, cap))
    } else {
        text.to_string()
    }
}

/// `max_length`: `None` = default window, `Some(0)` = unlimited.
pub fn paginate(content: &str, start_index: u64, max_length: Option<u64>) -> Window {
    let total = utf16_length(content) as u64;
    let start = start_index;
    if start >= total {
        return Window {
            content: String::new(),
            bytes: 0,
            total_length: total,
            start,
            end: start,
            has_more: false,
            next_start: None,
            capped: false,
        };
    }
    let limit = match max_length {
        None => DEFAULT_FETCH_MAX_LENGTH,
        Some(0) => total - start,
        Some(length) => length,
    };
    let raw_end = total.min(start.saturating_add(limit));
    let end = if raw_end < total && !content.is_ascii() {
        let units: Vec<u16> = content.encode_utf16().collect();
        let (high, low) = (units[raw_end as usize - 1], units[raw_end as usize]);
        if is_high(high) && is_low(low) {
            if raw_end - 1 > start { raw_end - 1 } else { raw_end + 1 }
        } else {
            raw_end
        }
    } else {
        raw_end
    };
    let slice = slice_utf16(content, start as usize, end as usize);
    let has_more = end < total;
    Window {
        bytes: slice.len(),
        content: slice,
        total_length: total,
        start,
        end,
        has_more,
        next_start: has_more.then_some(end),
        capped: has_more && max_length.is_none(),
    }
}

/// Footer for a page cut short, naming the `startIndex` that continues.
pub fn continuation(window: &Window) -> String {
    let (Some(next), true) = (window.next_start, window.has_more) else {
        return String::new();
    };
    let (start, end, total) = (window.start, window.end, window.total_length);
    if window.capped {
        format!(
            "\n\n[output capped at {} chars; chars {start}-{end} of {total}; startIndex:{next} for more]",
            end - start
        )
    } else {
        format!("\n\n[chars {start}-{end} of {total}; startIndex:{next} for more]")
    }
}

fn diagnostics(error_code: Option<&str>, is_error: bool, failures: &[Failure], attempts: &[Attempt]) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(code) = error_code {
        lines.push(format!("errorCode: {code}"));
    }
    let noteworthy = error_code.is_some()
        || is_error
        || !failures.is_empty()
        || attempts.iter().any(|attempt| !attempt.ok);
    if !attempts.is_empty() && noteworthy {
        let rendered: Vec<String> = attempts
            .iter()
            .map(|attempt| {
                format!(
                    "{}={} ({}ms)",
                    attempt.stage,
                    attempt.code.unwrap_or("success"),
                    attempt.elapsed_ms
                )
            })
            .collect();
        lines.push(format!("attempts: {}", rendered.join(" -> ")));
    }
    for failure in failures {
        let status = failure.status.map(|s| format!(" HTTP {s}")).unwrap_or_default();
        lines.push(format!(
            "failure: {} [{}]{status}: {}",
            failure.extractor, failure.code, failure.error
        ));
    }
    lines
}

pub fn format_fetch(items: &[FetchItem], urls_truncated: usize) -> String {
    if items.is_empty() {
        return "(no fetch results)".to_string();
    }
    let note = if urls_truncated > 0 {
        format!(
            "[fetched first {} of {urls_truncated} URLs; raise FETCH_URL_CAP for more]\n\n",
            items.len()
        )
    } else {
        String::new()
    };
    let rendered: Vec<String> = items
        .iter()
        .map(|item| match item {
            FetchItem::Error {
                url,
                error,
                error_code,
                failures,
                attempts,
            } => {
                let mut lines = vec![format!("[{url}]"), format!("(error: {error})")];
                lines.extend(diagnostics(Some(error_code), true, failures, attempts));
                lines.join("\n")
            }
            FetchItem::Success {
                url,
                title,
                window,
                failures,
                attempts,
            } => {
                let meta = [
                    format!("{} bytes", window.bytes),
                    format!("range={}..{}/{}", window.start, window.end, window.total_length),
                ]
                .join(", ");
                let header = format!("{url} ({meta})");
                let title = mixdog_js::js_words(title).collect::<Vec<_>>().join(" ");
                let mut head = vec![header];
                if !title.is_empty() {
                    head.push(format!("title: {title}"));
                }
                head.extend(diagnostics(None, false, failures, attempts));
                format!("{}\n\n{}{}", head.join("\n"), window.content, continuation(window))
            }
        })
        .collect();
    format!("{note}{}", rendered.join("\n\n---\n\n"))
}
