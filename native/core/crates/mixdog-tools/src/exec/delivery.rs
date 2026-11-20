//! One shape for every piece of shell output handed to an agent (`lib/shell-delivery.mjs`):
//! ANSI stripped and `\r` frames folded, over-long lines cut, a whole body when short, else a
//! head, an omission marker naming the full log, and a tail; harness-shaped tags escaped.
//! Lengths and cut points count UTF-16 units, as Node does.

use std::borrow::Cow;
use std::fmt::Write;
use std::sync::LazyLock;

use mixdog_js::cut_utf16;
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
    format!("[… {} lines, {} omitted — read with offset/limit or grep, full log: {}]", omitted.lines, format_kb(omitted.bytes as u64), omitted.path)
}

/// Step 1 for one chunk: ANSI stripped, then `\r` frames folded.
pub fn prepare_shell_text(text: &str, fold: &mut CarriageReturnFolder) -> String {
    fold.fold(&strip_ansi(text))
}

pub(super) fn ansi_stripped(text: &str) -> Cow<'_, str> {
    if text.contains(['\u{1b}', '\u{9b}']) { Cow::Owned(strip_ansi(text)) } else { Cow::Borrowed(text) }
}

/// A UTF-16 cut in UTF-8 text. When it divides a surrogate pair, `byte` points at
/// the scalar and each nonempty side containing a half emits U+FFFD.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Cut {
    byte: usize,
    split: bool,
}

impl Cut {
    fn after(self) -> usize {
        self.byte + if self.split { 4 } else { 0 }
    }

    fn head(self, text: &str) -> String {
        let mut head = text[..self.byte].to_owned();
        if self.split {
            head.push('\u{fffd}');
        }
        head
    }

    fn tail(self, text: &str) -> String {
        let mut tail = String::new();
        if self.split {
            tail.push('\u{fffd}');
        }
        tail.push_str(&text[self.after()..]);
        tail
    }
}

fn head_cut(text: &str, scale: f64) -> (Cut, usize) {
    let limit = (HEAD_MAX_CHARS * scale).floor() as usize;
    let (mut units, mut lines) = (0, 0);
    for (byte, ch) in text.char_indices() {
        if units + ch.len_utf16() > limit {
            return (Cut { byte, split: units < limit }, limit);
        }
        units += ch.len_utf16();
        if ch == '\n' {
            lines += 1;
            if lines == HEAD_LINES {
                return (Cut { byte: byte + 1, split: false }, units);
            }
        }
    }
    (Cut { byte: text.len(), split: false }, units)
}

fn tail_cut(text: &str, total_units: usize, floor: Cut, floor_units: usize, scale: f64) -> Cut {
    let mut want = (TAIL_CHARS * scale).floor() as usize;
    if want >= total_units - floor_units {
        return floor;
    }
    let mut cut = Cut { byte: text.len(), split: false };
    for (byte, ch) in text.char_indices().rev() {
        if want == 0 {
            break;
        }
        cut = Cut { byte, split: want < ch.len_utf16() };
        want = want.saturating_sub(ch.len_utf16());
    }
    if let Some(nl) = text[cut.after()..].find('\n')
        && cut.after() + nl + 1 < text.len()
        && utf16_len(&text[cut.after()..cut.after() + nl]) + usize::from(cut.split) < 200
    {
        return Cut { byte: cut.after() + nl + 1, split: false };
    }
    cut
}

fn join_head_tail(head: &str, tail: &str, omitted: &Omitted<'_>) -> String {
    let gap = if !head.is_empty() && !head.ends_with('\n') { "\n" } else { "" };
    format!("{head}{gap}{}\n{tail}", omission_marker(omitted))
}

/// One stream's delivery: `natural` is the length it would have whole (infinite when it can only
/// be shown at its ends) and `render(share, full_budget)` the text for its share in UTF-16 units.
pub struct Piece<'a> {
    natural: f64,
    render: Box<dyn Fn(f64, f64) -> String + Send + Sync + 'a>,
}

impl Piece<'_> {
    pub fn empty() -> Self {
        Self { natural: 0.0, render: Box::new(|_, _| String::new()) }
    }

    pub fn is_empty(&self) -> bool {
        self.natural == 0.0
    }
}

/// Fold a whole capture (if requested) and cut its long lines. Don't copy an unchanged
/// capture or allocate a separate string for every line.
fn shape_lines(text: &str, fold: bool) -> (Option<String>, usize) {
    let mut cut = 0;
    let mut shaped = None;
    let mut start = 0;
    for chunk in text.split_inclusive('\n') {
        let (line, newline) = chunk.strip_suffix('\n').map_or((chunk, ""), |line| (line, "\n"));
        let visible = if fold {
            let frame = if newline.is_empty() { line } else { line.strip_suffix('\r').unwrap_or(line) };
            frame.rsplit('\r').find(|s| !s.is_empty()).unwrap_or("")
        } else {
            line
        };
        let len = if visible.len() > LINE_MAX_CHARS { utf16_len(visible) } else { visible.len() };
        if visible.len() != line.len() || len > LINE_MAX_CHARS {
            shaped.get_or_insert_with(|| text[..start].to_owned());
        }
        if let Some(out) = &mut shaped {
            if len > LINE_MAX_CHARS {
                let head = cut_utf16(visible, LINE_MAX_CHARS);
                out.push_str(head.head);
                if head.dangling_high.is_some() {
                    out.push('\u{fffd}');
                }
                let removed = len - LINE_MAX_CHARS;
                cut += removed;
                let _ = write!(out, " … [{removed} chars cut]");
            } else {
                out.push_str(visible);
            }
            out.push_str(newline);
        }
        start += chunk.len();
    }
    (shaped, cut)
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
pub fn fit_pieces(pieces: &[Piece<'_>], budget: f64) -> Vec<String> {
    fit_pieces_at(pieces, budget, delivery_full_chars())
}

fn fit_pieces_at(pieces: &[Piece<'_>], budget: f64, full_budget: f64) -> Vec<String> {
    let lengths: Vec<f64> = pieces.iter().map(|p| p.natural).collect();
    let shares = share_budget(&lengths, budget);
    pieces
        .iter()
        .zip(shares)
        .map(|(piece, share)| {
            let text = (piece.render)(share, full_budget);
            if text.contains('<') { escape_harness_tags(&text) } else { text }
        })
        .collect()
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
    fn omitted_bytes_include_the_replacement_for_each_split_surrogate() {
        let head = "a".repeat(999);
        let tail = format!("{}\n{}", "c".repeat(999), "d".repeat(999));
        let body = format!("{head}😀{}\n{}\n{}😀{tail}", "b".repeat(999), "m".repeat(1040), ("m".repeat(999) + "\n").repeat(2));
        let delivered = fit_pieces_at(&[shell_text_piece(&body, "/l")], 6000.0, 6000.0).remove(0);
        // Each cut leaves half an emoji in the omitted middle. Each half weighs three
        // UTF-8 bytes there and is a replacement character on the visible side as well.
        assert_eq!(delivered, format!("{head}�\n[… 4 lines, 4.0 KB omitted — read with offset/limit or grep, full log: /l]\n�{tail}"),);
    }
}

/// `MIXDOG_SHELL_DELIVERY_MAX_CHARS`: the whole-delivery cap (a positive integer, else 6000).
pub fn delivery_full_chars() -> f64 {
    static FULL: LazyLock<f64> = LazyLock::new(|| {
        std::env::var("MIXDOG_SHELL_DELIVERY_MAX_CHARS").ok().and_then(|raw| parse_int_prefix(&raw)).filter(|n| *n > 0).map_or(6_000.0, |n| n as f64)
    });
    *FULL
}
/// Step 3 when only the two ends of a long range were read: `total_*` describe the whole range.
pub fn edges_piece(head_text: &str, tail_text: &str, total_bytes: usize, total_lines: usize, path: &str) -> Piece<'static> {
    let head_text = head_text.to_owned();
    let tail_text = tail_text.to_owned();
    let path = path.to_owned();
    Piece {
        natural: f64::INFINITY,
        render: Box::new(move |budget, full_budget| {
            let scale = budget / full_budget;
            let head_text = escape_harness_tags(&head_text);
            let tail_text = escape_harness_tags(&tail_text);
            let head = head_cut(&head_text, scale).0.head(&head_text);
            let tail = tail_cut(&tail_text, utf16_len(&tail_text), Cut { byte: 0, split: false }, 0, scale).tail(&tail_text);
            let omitted = Omitted {
                lines: total_lines.saturating_sub(count_newlines(&head)).saturating_sub(count_newlines(&tail)),
                bytes: total_bytes.saturating_sub(head.len()).saturating_sub(tail.len()),
                path: &path,
            };
            join_head_tail(&head, &tail, &omitted)
        }),
    }
}
/// Steps 2, 3 and 5 on prepared text. `path` names where the whole (uncut) text can be read.
pub fn text_piece(text: &str, path: &str) -> Piece<'static> {
    let (shown, cut) = shape_text(Cow::Borrowed(text), false);
    shaped_piece(Cow::Owned(shown.into_owned()), cut, path)
}

fn shape_text(text: Cow<'_, str>, fold: bool) -> (Cow<'_, str>, usize) {
    let (shaped, cut) = shape_lines(&text, fold);
    let shown = shaped.map_or(text, Cow::Owned);
    let shown = if shown.contains('<') { Cow::Owned(escape_harness_tags(&shown)) } else { shown };
    (shown, cut)
}

fn shaped_piece<'a>(shown: Cow<'a, str>, cut: usize, path: &str) -> Piece<'a> {
    let suffix = if cut > 0 {
        let sep = if shown.ends_with('\n') { "" } else { "\n" };
        format!("{sep}{}\n", omission_marker(&Omitted { lines: 0, bytes: cut, path }))
    } else {
        String::new()
    };
    let units = utf16_len(&shown);
    let natural = (units + utf16_len(&suffix)) as f64;
    let path = path.to_owned();
    Piece {
        natural,
        render: Box::new(move |budget, full_budget| {
            if natural <= budget {
                return format!("{shown}{suffix}");
            }
            let scale = budget / full_budget;
            let (head, head_units) = head_cut(&shown, scale);
            let tail = tail_cut(&shown, units, head, head_units, scale);
            let (lines, bytes) = if head == tail {
                (0, 0)
            } else {
                let middle = &shown[head.after()..tail.byte];
                let partial = usize::from(head.split) + usize::from(tail.split);
                (count_newlines(middle), middle.len() + partial * '\u{fffd}'.len_utf8())
            };
            join_head_tail(&head.head(&shown), &tail.tail(&shown), &Omitted { lines, bytes, path: &path })
        }),
    }
}
/// Steps 1–5 for a whole string.
pub fn shell_text_piece<'a>(text: &'a str, path: &str) -> Piece<'a> {
    stripped_shell_piece(ansi_stripped(text), path)
}

pub(super) fn stripped_shell_piece<'a>(text: Cow<'a, str>, path: &str) -> Piece<'a> {
    let (shown, cut) = shape_text(text, true);
    shaped_piece(shown, cut, path)
}
