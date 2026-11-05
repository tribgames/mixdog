//! Single-range `Range` parsing (apps/relay/lib/media-http.mjs `parseRange`) and the
//! segment-aligned window one request is answered with.

use super::crypto::MEDIA_SEGMENT_BYTES;

/// Plaintext served per request; a longer range continues in the next one.
pub const MEDIA_WINDOW_MAX_BYTES: u64 = 1024 * 1024;
/// A download is read start to end, so each of its requests carries more.
pub const DOWNLOAD_WINDOW_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Range {
    /// No (or an empty) header: the whole file.
    Whole,
    Bytes { start: u64, end: u64 },
    Unsatisfiable,
}

/// Only the single-range form is supported; every player falls back to it.
pub fn parse_range(header: &str, size: u64) -> Range {
    let raw = mixdog_js::js_trim(header);
    if raw.is_empty() {
        return Range::Whole;
    }
    let Some(spec) = raw.strip_prefix("bytes=") else { return Range::Unsatisfiable };
    let Some((first, last)) = spec.split_once('-') else { return Range::Unsatisfiable };
    // `/^bytes=(\d*)-(\d*)$/`: `\d` is ASCII, and a second `-` cannot match.
    let digits = |text: &str| text.bytes().all(|b| b.is_ascii_digit());
    if size == 0 || !digits(first) || !digits(last) || (first.is_empty() && last.is_empty()) {
        return Range::Unsatisfiable;
    }
    // `Number(digits)`: a very long run is a large finite double, not an error.
    let number = mixdog_js::string_to_number;
    let size_f = size as f64;
    let (start, end) = if first.is_empty() {
        let length = number(last);
        if !length.is_finite() || length <= 0.0 {
            return Range::Unsatisfiable;
        }
        ((size_f - length).max(0.0), size_f - 1.0)
    } else {
        (number(first), if last.is_empty() { size_f - 1.0 } else { number(last) })
    };
    if !start.is_finite() || !end.is_finite() || start > end || start >= size_f {
        return Range::Unsatisfiable;
    }
    Range::Bytes { start: start as u64, end: end.min(size_f - 1.0) as u64 }
}

/// The inclusive plaintext window `[start, end]` of a request, on the segment grid and bounded
/// by `window_bytes`. `end < start` for an empty file.
pub fn window(range: Range, size: u64, window_bytes: u64) -> Option<(u64, i128)> {
    let (requested_start, requested_end) = match range {
        Range::Unsatisfiable => return None,
        Range::Whole => (0, size as i128 - 1),
        Range::Bytes { start, end } => (start, i128::from(end)),
    };
    let start = requested_start / MEDIA_SEGMENT_BYTES * MEDIA_SEGMENT_BYTES;
    let capped = requested_end.min(i128::from(start) + i128::from(window_bytes) - 1);
    let aligned = (capped.div_euclid(i128::from(MEDIA_SEGMENT_BYTES)) + 1) * i128::from(MEDIA_SEGMENT_BYTES) - 1;
    Some((start, aligned.min(size as i128 - 1)))
}
