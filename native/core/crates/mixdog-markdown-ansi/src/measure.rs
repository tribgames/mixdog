//! Row-height measurement of rendered markdown (`measure-rendered-rows.mjs`): how many terminal rows a text occupies
//! once rendered, lockstep with what the renderer paints (a table by the table layout of [`crate::table`], every other
//! block word-wrapped greedily, one blank row between blocks).
//!
//! The streaming measurement keeps the latest measurement of each live stream by its key, at most 32 streams
//! ([`STREAMING_ROWS_LRU_MAX`]), so abandoned streams cannot make the cache retain an unbounded response history.

use std::sync::{LazyLock, Mutex, PoisonError};

use mixdog_js::is_js_space;
use mixdog_termtext::{display_width, strip_ansi};

use crate::lru::Lru;
use crate::render::{RenderOptions, render_token_ansi_segments};
use crate::table::{assistant_body_width, measure_markdown_table_rows};

/// The latest measurements kept, one per live stream.
const STREAMING_ROWS_LRU_MAX: usize = 32;

/// `wrappedLineRows(line, width)`: how many terminal rows ONE logical line (no `\n`) occupies once word-wrapped. It
/// mirrors the greedy word wrap, so a row estimate is never lower than what is painted; the transcript row estimate
/// shares it.
pub fn wrapped_line_rows(line: &str, width: usize) -> usize {
    let full = display_width(line);
    if full <= width {
        return 1;
    }
    // Only a line wider than the width gets here, so the width is not 0 unless the caller passed none.
    let width = width.max(1);
    let mut rows = 1;
    let mut col = 0;
    for run in runs(line) {
        let run_width = display_width(run);
        if run_width == 0 {
            continue;
        }
        if run_width > width {
            if col > 0 {
                rows += 1;
            }
            rows += run_width.div_ceil(width) - 1;
            col = if run_width % width == 0 { width } else { run_width % width };
            continue;
        }
        if col + run_width > width {
            rows += 1;
            col = run_width;
        } else {
            col += run_width;
        }
    }
    rows.max(1)
}

/// The pieces `text.split(/(\s+)/)` gives, the empty ones left out: alternating runs of whitespace and of the rest.
fn runs(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        let first = rest.chars().next()?;
        let space = is_js_space(first);
        let end = rest.find(|ch: char| is_js_space(ch) != space).unwrap_or(rest.len());
        let (run, tail) = rest.split_at(end);
        rest = tail;
        Some(run)
    })
}

/// The rows of every line of `text` (split at `\n`) at `width`, added.
fn rows_of_lines(text: &str, width: usize) -> usize {
    text.split('\n').map(|line| wrapped_line_rows(line, width)).sum()
}

/// `measureMarkdownRenderedRows(text, columns, { trimPartialFences })`: the rows the markdown `text` occupies at
/// `columns` terminal columns (the body is three columns narrower).
pub fn measure_markdown_rendered_rows(text: &str, columns: usize, trim_partial_fences: bool) -> usize {
    if text.is_empty() {
        return 1;
    }
    let body_width = assistant_body_width(columns);
    let segments = render_token_ansi_segments(text, RenderOptions { width: body_width, trim_partial_fences });
    if segments.is_empty() {
        return 1;
    }
    let mut rows = 0;
    for segment in segments.iter() {
        match segment.ansi() {
            None => rows += measure_markdown_table_rows(segment.token(), body_width).max(1),
            Some(ansi) => rows += rows_of_lines(&strip_ansi(ansi), body_width),
        }
    }
    // One blank row between two blocks.
    rows += segments.len() - 1;
    rows.max(1)
}

/// The split of a streaming text the measurement reads (`resolveStreamingMarkdownParts`' result of
/// `streaming-markdown.mjs`): the settled part, in the chunks it was settled in, and the live tail.
pub trait StreamingSplit {
    /// The text renders flat, with no markdown syntax.
    fn plain(&self) -> bool;
    /// The live tail as it is rendered (a plain text is all of it).
    fn unstable_for_render(&self) -> &str;
    /// The settled part, whole.
    fn stable_prefix(&self) -> &str;
    /// The settled part in the chunks it grew by; empty when it has none.
    fn stable_chunks(&self) -> &[String];
    /// The live tail as written.
    fn unstable_suffix(&self) -> &str;
}

/// `streamingStableChunks(parts)`: the settled chunks of a split; render and row measurement share this split.
pub fn streaming_stable_chunks(parts: &dyn StreamingSplit) -> Vec<String> {
    if !parts.stable_chunks().is_empty() {
        return parts.stable_chunks().to_vec();
    }
    if parts.stable_prefix().is_empty() { Vec::new() } else { vec![parts.stable_prefix().to_owned()] }
}

/// What the latest measurement of a stream remembers beyond its text and width.
#[derive(Clone)]
enum Mode {
    Empty,
    Plain { stable_prefix: String, stable_rows: usize },
    Markdown { stable_chunks: Vec<String>, stable_rows: usize },
}

#[derive(Clone)]
struct Measured {
    text: String,
    columns: usize,
    mode: Mode,
    rows: usize,
}

static STREAMING_ROWS: LazyLock<Mutex<Lru<String, Measured>>> =
    LazyLock::new(|| Mutex::new(Lru::new(STREAMING_ROWS_LRU_MAX)));

fn cached_rows(key: Option<&str>) -> Option<Measured> {
    let key = key?;
    STREAMING_ROWS.lock().unwrap_or_else(PoisonError::into_inner).get(key).cloned()
}

fn cache_rows(key: Option<&str>, entry: Measured) {
    if let Some(key) = key {
        STREAMING_ROWS.lock().unwrap_or_else(PoisonError::into_inner).touch(key.to_owned(), entry);
    }
}

/// `measureStreamingMarkdownRenderedRows(text, columns, streamKey)`: the rows a growing text occupies at `columns`
/// columns. `resolve` splits the text (`resolveStreamingMarkdownParts(text, streamKey)`); it is called only when the
/// stream's latest measurement is not of this very text and width, so a repaint caused by typing or an overlay does no
/// wrapping or token work while the live tail did not change. A stream with a key keeps its latest measurement: the
/// rows of the settled chunks and of the complete lines before the growing one are not measured again.
pub fn measure_streaming_markdown_rows<P: StreamingSplit>(
    text: &str,
    columns: usize,
    stream_key: Option<&str>,
    resolve: impl FnOnce(&str, Option<&str>) -> P,
) -> usize {
    let key = stream_key.filter(|key| !key.is_empty());
    let cached = cached_rows(key);
    if let Some(hit) = cached.as_ref().filter(|hit| hit.text == text && hit.columns == columns) {
        cache_rows(key, hit.clone());
        return hit.rows;
    }
    if text.is_empty() {
        cache_rows(key, Measured { text: String::new(), columns, mode: Mode::Empty, rows: 1 });
        return 1;
    }
    let parts = resolve(text, key);
    if parts.plain() {
        return measure_plain(text, columns, key, cached, parts.unstable_for_render());
    }
    measure_markdown(text, columns, key, cached, &parts)
}

fn measure_plain(text: &str, columns: usize, key: Option<&str>, cached: Option<Measured>, plain: &str) -> usize {
    let width = assistant_body_width(columns);
    let last_break = plain.rfind('\n');
    let stable_prefix = last_break.map_or("", |at| &plain[..=at]);
    let reused = cached.as_ref().and_then(|hit| match &hit.mode {
        Mode::Plain { stable_prefix: previous, stable_rows }
            if hit.columns == columns && stable_prefix.starts_with(previous.as_str()) =>
        {
            Some((previous.len(), *stable_rows))
        }
        _ => None,
    });
    let stable_rows = match (reused, last_break) {
        (Some((previous_len, rows)), _) => {
            // The lines before the growing final line wrap independently: measure only the complete lines added since
            // the previous split.
            let end = last_break.map_or(previous_len, |at| at.max(previous_len));
            let added = &plain[previous_len..end];
            if added.is_empty() { rows } else { rows + rows_of_lines(added, width) }
        }
        (None, Some(at)) => rows_of_lines(&plain[..at], width),
        (None, None) => 0,
    };
    let final_line = last_break.map_or(plain, |at| &plain[at + 1..]);
    let rows = (stable_rows + wrapped_line_rows(final_line, width)).max(1);
    cache_rows(
        key,
        Measured {
            text: text.to_owned(),
            columns,
            mode: Mode::Plain { stable_prefix: stable_prefix.to_owned(), stable_rows },
            rows,
        },
    );
    rows
}

fn measure_markdown(
    text: &str,
    columns: usize,
    key: Option<&str>,
    cached: Option<Measured>,
    parts: &dyn StreamingSplit,
) -> usize {
    let stable_chunks = streaming_stable_chunks(parts);
    let reusable = cached.as_ref().and_then(|hit| match &hit.mode {
        Mode::Markdown { stable_chunks: previous, stable_rows }
            if hit.columns == columns
                && previous.len() <= stable_chunks.len()
                && previous.iter().zip(&stable_chunks).all(|(a, b)| a == b) =>
        {
            Some((previous.len(), *stable_rows))
        }
        _ => None,
    });
    let (measured_chunks, mut stable_rows) = reusable.unwrap_or((0, 0));
    for (index, chunk) in stable_chunks.iter().enumerate().skip(measured_chunks) {
        if index > 0 {
            stable_rows += 1;
        }
        stable_rows += measure_markdown_rendered_rows(chunk, columns, false);
    }
    let mut rows = stable_rows;
    let mut child_count = stable_chunks.len();
    if !parts.unstable_suffix().is_empty() {
        if child_count > 0 {
            rows += 1;
        }
        rows += measure_markdown_rendered_rows(parts.unstable_for_render(), columns, true);
        child_count += 1;
    }
    let measured_rows = if child_count == 0 { 1 } else { rows.max(1) };
    cache_rows(
        key,
        Measured {
            text: text.to_owned(),
            columns,
            mode: Mode::Markdown { stable_chunks, stable_rows },
            rows: measured_rows,
        },
    );
    measured_rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Parts {
        plain: bool,
        stable_prefix: String,
        stable_chunks: Vec<String>,
        unstable_suffix: String,
        unstable_for_render: String,
    }

    impl StreamingSplit for Parts {
        fn plain(&self) -> bool {
            self.plain
        }
        fn unstable_for_render(&self) -> &str {
            &self.unstable_for_render
        }
        fn stable_prefix(&self) -> &str {
            &self.stable_prefix
        }
        fn stable_chunks(&self) -> &[String] {
            &self.stable_chunks
        }
        fn unstable_suffix(&self) -> &str {
            &self.unstable_suffix
        }
    }

    fn plain_parts(text: &str) -> Parts {
        Parts {
            plain: true,
            stable_prefix: String::new(),
            stable_chunks: Vec::new(),
            unstable_suffix: text.to_owned(),
            unstable_for_render: text.to_owned(),
        }
    }

    #[test]
    fn a_line_wraps_greedily_by_words_and_a_long_word_by_cells() {
        assert_eq!(wrapped_line_rows("", 10), 1);
        assert_eq!(wrapped_line_rows("short", 10), 1);
        assert_eq!(wrapped_line_rows("aaaa bbbb cccc", 9), 2);
        // A separator that does not fit starts a row of its own, as the Node count has it: five rows.
        assert_eq!(wrapped_line_rows("aaaa bbbb cccc", 4), 5);
        // A word wider than the width starts its own row and fills ceil(w / width) rows after the row it started on.
        assert_eq!(wrapped_line_rows("ab cdefghijkl", 5), 3);
        assert_eq!(wrapped_line_rows("abcdefghij", 5), 2);
        assert_eq!(wrapped_line_rows("abcdefghijk", 5), 3);
        // Two-cell characters count by cells.
        assert_eq!(wrapped_line_rows("\u{65e5}\u{672c}\u{8a9e}", 4), 2);
    }

    #[test]
    fn markdown_rows_count_blocks_tables_and_the_blank_row_between() {
        assert_eq!(measure_markdown_rendered_rows("", 80, false), 1);
        assert_eq!(measure_markdown_rendered_rows("hello", 80, false), 1);
        assert_eq!(measure_markdown_rendered_rows("# a\n\ntext", 80, false), 3);
        // Header rule, header, rule, row, rule: five lines.
        assert_eq!(measure_markdown_rendered_rows("| a | b |\n| - | - |\n| 1 | 2 |\n", 80, false), 5);
        assert_eq!(measure_markdown_rendered_rows("| a | b |\n| - | - |\n| 1 | 2 |\n\nafter", 80, false), 7);
    }

    #[test]
    fn a_plain_stream_measures_only_what_was_added() {
        let key = Some("measure-plain");
        let calls = Cell::new(0);
        let resolve = |text: &str, _: Option<&str>| {
            calls.set(calls.get() + 1);
            plain_parts(text)
        };
        assert_eq!(measure_streaming_markdown_rows("one\ntwo", 80, key, resolve), 2);
        assert_eq!(measure_streaming_markdown_rows("one\ntwo\nthree", 80, key, resolve), 3);
        // The very text again is answered from the cache, without a split.
        assert_eq!(measure_streaming_markdown_rows("one\ntwo\nthree", 80, key, resolve), 3);
        assert_eq!(calls.get(), 2);
        // A different width measures again.
        assert_eq!(measure_streaming_markdown_rows("one\ntwo\nthree", 10, key, resolve), 3);
        assert_eq!(calls.get(), 3);
        assert_eq!(measure_streaming_markdown_rows("", 80, key, resolve), 1);
        assert_eq!(calls.get(), 3);
        // A regression to shorter text is measured from scratch.
        assert_eq!(measure_streaming_markdown_rows("a\nb\nc\nd", 80, key, resolve), 4);
        assert_eq!(measure_streaming_markdown_rows("a", 80, key, resolve), 1);
    }

    #[test]
    fn a_markdown_stream_adds_one_blank_row_between_chunks_and_the_tail() {
        let key = Some("measure-markdown");
        let split = |chunks: &[&str], tail: &str| Parts {
            plain: false,
            stable_prefix: chunks.concat(),
            stable_chunks: chunks.iter().map(|chunk| (*chunk).to_owned()).collect(),
            unstable_suffix: tail.to_owned(),
            unstable_for_render: tail.to_owned(),
        };
        let first = measure_streaming_markdown_rows("# a\n\n- x", 80, key, |_, _| split(&["# a\n\n"], "- x"));
        assert_eq!(first, 3);
        let second = measure_streaming_markdown_rows("# a\n\n- x\n\n- y", 80, key, |_, _| split(&["# a\n\n", "- x\n\n"], "- y"));
        assert_eq!(second, 5);
        // Settled chunks only: no tail.
        let settled = measure_streaming_markdown_rows("# a\n\nb\n\n", 80, key, |_, _| split(&["# a\n\n", "b\n\n"], ""));
        assert_eq!(settled, 3);
        // Nothing settled and no tail is one row.
        assert_eq!(measure_streaming_markdown_rows("\n", 80, None, |_, _| split(&[], "")), 1);
    }

    #[test]
    fn the_stable_chunks_fall_back_to_the_prefix() {
        let mut parts = plain_parts("");
        assert!(streaming_stable_chunks(&parts).is_empty());
        parts.stable_prefix = "abc".to_owned();
        assert_eq!(streaming_stable_chunks(&parts), ["abc"]);
        parts.stable_chunks = vec!["a".to_owned(), "bc".to_owned()];
        assert_eq!(streaming_stable_chunks(&parts), ["a", "bc"]);
    }

    #[test]
    fn at_most_thirty_two_streams_are_remembered() {
        for index in 0..40 {
            let key = format!("lru-{index}");
            measure_streaming_markdown_rows("x", 80, Some(&key), |text, _| plain_parts(text));
        }
        assert_eq!(cached_rows(Some("lru-0")).map(|hit| hit.rows), None);
        assert_eq!(cached_rows(Some("lru-39")).map(|hit| hit.rows), Some(1));
    }
}
