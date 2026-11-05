//! One shape for every piece of shell output handed to an agent (`lib/shell-delivery.mjs`):
//! ANSI stripped and `\r` frames folded, over-long lines cut, a whole body when short, else a
//! head, an omission marker naming the full log, and a tail; harness-shaped tags escaped.
//! Lengths and cut points count UTF-16 units, as Node does.

use std::sync::LazyLock;

use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;

use super::text::CarriageReturnFolder;
use super::text::count_newlines;
use super::text::escape_harness_tags;
use super::text::format_kb;
use super::text::strip_ansi;

const HEAD_LINES: usize = 10;
const HEAD_MAX_CHARS: f64 = 1_000.0;
const TAIL_CHARS: f64 = 2_000.0;
const LINE_MAX_CHARS: usize = 2_000;

/// `MIXDOG_SHELL_DELIVERY_MAX_CHARS`: the whole-delivery cap (a positive integer, else 6000).
pub fn delivery_full_chars() -> f64 {
    static FULL: LazyLock<f64> = LazyLock::new(|| {
        std::env::var("MIXDOG_SHELL_DELIVERY_MAX_CHARS")
            .ok()
            .and_then(|raw| parse_int_prefix(&raw))
            .filter(|n| *n > 0)
            .map_or(6_000.0, |n| n as f64)
    });
    *FULL
}

/// JavaScript `parseInt(text, 10)`: optional sign and leading digits.
pub fn parse_int_prefix(text: &str) -> Option<i64> {
    let trimmed = mixdog_js::js_trim_start(text);
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    digits[..end].parse::<i64>().ok().map(|n| sign * n)
}

/// What an omission marker reports.
pub struct Omitted<'a> {
    pub lines: usize,
    pub bytes: usize,
    pub path: &'a str,
}

/// The omission marker, identical on every delivery path, the log path last.
pub fn omission_marker(omitted: &Omitted<'_>) -> String {
    format!(
        "[… {} lines, {} omitted — read with offset/limit or grep, full log: {}]",
        omitted.lines,
        format_kb(omitted.bytes as u64),
        omitted.path
    )
}

/// Step 1 for one chunk: ANSI stripped, then `\r` frames folded.
pub fn prepare_shell_text(text: &str, fold: &mut CarriageReturnFolder) -> String {
    fold.fold(&strip_ansi(text))
}

fn u16s(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn from16(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn slice16(units: &[u16], from: usize, to: usize) -> String {
    from16(&units[from.min(units.len())..to.min(units.len())])
}

fn index_of_newline(units: &[u16], from: usize) -> Option<usize> {
    (from..units.len()).find(|&i| units[i] == u16::from(b'\n'))
}

/// `scale` is the share of the delivery budget a stream was given.
fn head_of(text: &str, scale: f64) -> String {
    let units = u16s(text);
    let mut end = 0;
    let mut line = 0;
    while line < HEAD_LINES && end < units.len() {
        end = index_of_newline(&units, end).map_or(units.len(), |nl| nl + 1);
        line += 1;
    }
    slice16(&units, 0, end.min((HEAD_MAX_CHARS * scale).floor() as usize))
}

fn tail_of(text: &str, floor: usize, scale: f64) -> String {
    let units = u16s(text);
    let want = (TAIL_CHARS * scale).floor() as i64;
    let start = (units.len() as i64 - want).max(floor as i64) as usize;
    if start == floor {
        return slice16(&units, start, units.len());
    }
    match index_of_newline(&units, start) {
        Some(nl) if nl - start < 200 && nl + 1 < units.len() => slice16(&units, nl + 1, units.len()),
        _ => slice16(&units, start, units.len()),
    }
}

fn join_head_tail(head: &str, tail: &str, omitted: &Omitted<'_>) -> String {
    let gap = if !head.is_empty() && !head.ends_with('\n') { "\n" } else { "" };
    format!("{head}{gap}{}\n{tail}", omission_marker(omitted))
}

/// One stream's delivery: `natural` is the length it would have whole (infinite when it can only
/// be shown at its ends) and `render(budget)` the text within `budget` UTF-16 units.
pub struct Piece {
    natural: f64,
    render: Box<dyn Fn(f64) -> String + Send + Sync>,
}

impl Piece {
    pub fn empty() -> Self {
        Self { natural: 0.0, render: Box::new(|_| String::new()) }
    }

    pub fn is_empty(&self) -> bool {
        self.natural == 0.0
    }
}

/// Step 3 when only the two ends of a long range were read: `total_*` describe the whole range.
pub fn edges_piece(head_text: &str, tail_text: &str, total_bytes: usize, total_lines: usize, path: &str) -> Piece {
    let head_text = head_text.to_owned();
    let tail_text = tail_text.to_owned();
    let path = path.to_owned();
    Piece {
        natural: f64::INFINITY,
        render: Box::new(move |budget| {
            let scale = budget / delivery_full_chars();
            let head = head_of(&escape_harness_tags(&head_text), scale);
            let tail = tail_of(&escape_harness_tags(&tail_text), 0, scale);
            let omitted = Omitted {
                lines: total_lines.saturating_sub(count_newlines(&head)).saturating_sub(count_newlines(&tail)),
                bytes: total_bytes.saturating_sub(head.len()).saturating_sub(tail.len()),
                path: &path,
            };
            join_head_tail(&head, &tail, &omitted)
        }),
    }
}

/// `(text with long lines cut, units cut)`.
fn cut_long_lines(text: &str) -> (String, usize) {
    if utf16_len(text) <= LINE_MAX_CHARS {
        return (text.to_owned(), 0);
    }
    let mut cut = 0;
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let len = utf16_len(line);
            if len <= LINE_MAX_CHARS {
                return line.to_owned();
            }
            cut += len - LINE_MAX_CHARS;
            format!("{} … [{} chars cut]", slice_utf16(line, LINE_MAX_CHARS), len - LINE_MAX_CHARS)
        })
        .collect();
    (lines.join("\n"), cut)
}

/// Steps 2, 3 and 5 on prepared text. `path` names where the whole (uncut) text can be read.
pub fn text_piece(text: &str, path: &str) -> Piece {
    let (cut_text, cut) = cut_long_lines(text);
    let shown = escape_harness_tags(&cut_text);
    let whole = if cut > 0 {
        let sep = if shown.ends_with('\n') { "" } else { "\n" };
        format!("{shown}{sep}{}\n", omission_marker(&Omitted { lines: 0, bytes: cut, path }))
    } else {
        shown.clone()
    };
    let path = path.to_owned();
    Piece {
        natural: utf16_len(&whole) as f64,
        render: Box::new(move |budget| {
            if (utf16_len(&whole) as f64) <= budget {
                return whole.clone();
            }
            let scale = budget / delivery_full_chars();
            let head = head_of(&shown, scale);
            let head_len = utf16_len(&head);
            let tail = tail_of(&shown, head_len, scale);
            let units = u16s(&shown);
            let middle = slice16(&units, head_len, units.len().saturating_sub(utf16_len(&tail)));
            join_head_tail(
                &head,
                &tail,
                &Omitted { lines: count_newlines(&middle), bytes: middle.len(), path: &path },
            )
        }),
    }
}

/// Max-min fair split of `budget` over the streams' natural lengths.
fn share_budget(lengths: &[f64], budget: f64) -> Vec<f64> {
    let mut shares = vec![0.0; lengths.len()];
    let mut open: Vec<usize> = (0..lengths.len()).collect();
    let mut left = budget.max(0.0);
    while !open.is_empty() {
        let fair = left / open.len() as f64;
        let fits: Vec<usize> = open.iter().copied().filter(|&i| lengths[i] <= fair).collect();
        if fits.is_empty() {
            for &i in &open {
                shares[i] = fair;
            }
            break;
        }
        for &i in &fits {
            shares[i] = lengths[i];
            left -= lengths[i];
        }
        open.retain(|i| !fits.contains(i));
    }
    shares
}

/// Delivers streams within one shared budget, each escaped.
pub fn fit_pieces(pieces: &[Piece], budget: f64) -> Vec<String> {
    let lengths: Vec<f64> = pieces.iter().map(|p| p.natural).collect();
    let shares = share_budget(&lengths, budget);
    pieces
        .iter()
        .zip(shares)
        .map(|(piece, share)| escape_harness_tags(&(piece.render)(share)))
        .collect()
}

/// Steps 1–5 for a whole string.
pub fn shell_text_piece(text: &str, path: &str) -> Piece {
    let prepared = prepare_shell_text(text, &mut CarriageReturnFolder::default());
    text_piece(&prepared, path)
}

/// `renderShellOutputBody`: stdout, a break when it lacks one, stderr; `(no output)` when empty.
pub fn render_shell_output_body(stdout: &str, stderr: &str) -> String {
    let gap = if !stdout.is_empty() && !stderr.is_empty() && !stdout.ends_with('\n') { "\n" } else { "" };
    let body = format!("{stdout}{gap}{stderr}");
    if body.is_empty() { "(no output)".to_owned() } else { body }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_delivered_whole_and_long_text_keeps_both_ends() {
        let piece = shell_text_piece("hello\n", "/log");
        assert_eq!(fit_pieces(&[piece], 6000.0), vec!["hello\n".to_owned()]);

        let body: String = (0..3000).map(|i| format!("line {i}\n")).collect();
        let delivered = fit_pieces(&[shell_text_piece(&body, "/log/out")], 6000.0).remove(0);
        assert!(delivered.starts_with("line 0\nline 1\n"));
        assert!(delivered.ends_with("line 2999\n"));
        assert!(delivered.contains("lines, "));
        assert!(delivered.contains(" omitted — read with offset/limit or grep, full log: /log/out]\n"));
        assert!(utf16_len(&delivered) < 3_500);
    }

    #[test]
    fn an_over_long_line_is_cut_with_a_marker() {
        let line = "x".repeat(2_500);
        let delivered = fit_pieces(&[shell_text_piece(&line, "/l")], 6000.0).remove(0);
        assert!(delivered.starts_with(&"x".repeat(2_000)));
        assert!(delivered.contains(" … [500 chars cut]\n[… 0 lines, 0.5 KB omitted — read with offset/limit or grep, full log: /l]\n"));
    }

    #[test]
    fn streams_share_one_budget_fairly() {
        assert_eq!(share_budget(&[10.0, 100.0], 60.0), vec![10.0, 50.0]);
        assert_eq!(share_budget(&[f64::INFINITY, 20.0], 60.0), vec![40.0, 20.0]);
    }

    #[test]
    fn the_body_joins_streams_with_a_break_and_names_empty_output() {
        assert_eq!(render_shell_output_body("a", "b"), "a\nb");
        assert_eq!(render_shell_output_body("a\n", "b"), "a\nb");
        assert_eq!(render_shell_output_body("", ""), "(no output)");
    }

    #[test]
    fn parse_int_follows_javascript() {
        assert_eq!(parse_int_prefix("123abc"), Some(123));
        assert_eq!(parse_int_prefix("  -4"), Some(-4));
        assert_eq!(parse_int_prefix("abc"), None);
    }
}
