//! `pdf-search.mjs`: text search over a PDF layout. Where a phrase sits on the page, as a box in the layout's top-left
//! coordinates. Pure functions; the layout comes from [`crate::analysis::layout::extract_pdf_text_layout`].
//!
//! Positions inside a line are UTF-16 code unit offsets, as JavaScript counts them: a word boundary tests the unit
//! before and after a match, and the width a character takes of its run is read per unit.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, is_js_space, js_sort_by, js_to_lowercase, js_trim, slice_utf16, utf16_len};
use serde_json::Value;

use crate::analysis::layout::{LayoutItem, PageLayout, PdfLayout};
use crate::analysis::{collapse_spaces, js_max, js_min, json_number, object, round2};
use crate::document::AnalysisError;
use crate::limits::DEFAULT_SEARCH_LIMIT;

const SEARCH_LINE_TOLERANCE: f64 = 2.0;

/// A box in the layout's top-left coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// One match. A phrase that wraps across lines has one box per line in `rects`, and the first of them is the match's
/// own box.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchMatch {
    pub page: usize,
    pub text: String,
    pub line: String,
    pub rect: Rect,
    pub rects: Option<Vec<Rect>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub query: String,
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

/// `{ limit, wholeWord, regex }`.
#[derive(Debug, Clone, Copy)]
pub struct SearchOptions {
    pub limit: usize,
    pub whole_word: bool,
    pub regex: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions { limit: DEFAULT_SEARCH_LIMIT, whole_word: false, regex: false }
    }
}

/// A line is the runs that share a baseline: the same `top` for upright text, the same `x` for text standing on a
/// rotated page. Runs are ordered along the reading direction, which a reversed run walks backwards.
#[derive(Clone)]
struct Line<'a> {
    key: f64,
    vertical: bool,
    reversed: bool,
    items: Vec<&'a LayoutItem>,
}

fn layout_lines(page: &PageLayout) -> Vec<Line<'_>> {
    let mut lines: Vec<Line<'_>> = Vec::new();
    for item in &page.items {
        if item.text.is_empty() {
            continue;
        }
        let key = if item.vertical { item.x } else { item.top };
        let found = lines
            .iter()
            .position(|entry| entry.vertical == item.vertical && entry.reversed == item.reversed && (entry.key - key).abs() <= SEARCH_LINE_TOLERANCE);
        match found {
            Some(at) => lines[at].items.push(item),
            None => lines.push(Line { key, vertical: item.vertical, reversed: item.reversed, items: vec![item] }),
        }
    }
    for line in &mut lines {
        let (vertical, reversed) = (line.vertical, line.reversed);
        let along = move |item: &LayoutItem| if vertical { item.top } else { item.x };
        js_sort_by(&mut line.items, |left, right| if reversed { along(*right) - along(*left) } else { along(*left) - along(*right) });
    }
    // Row order follows the normal to the reading direction, not display y: rotating a page must not turn its last
    // row into the first match.
    let row_position = |line: &Line<'_>| {
        if line.vertical { line.key * if line.reversed { 1.0 } else { -1.0 } } else { line.key * if line.reversed { -1.0 } else { 1.0 } }
    };
    js_sort_by(&mut lines, |left, right| row_position(left) - row_position(right));
    lines
}

/// Space between two consecutive runs along the reading direction.
fn run_gap(previous: &LayoutItem, item: &LayoutItem, line: &Line<'_>) -> f64 {
    if line.vertical {
        if line.reversed { previous.top - (item.top + item.height) } else { item.top - (previous.top + previous.height) }
    } else if line.reversed {
        previous.x - (item.x + item.width)
    } else {
        item.x - (previous.x + previous.width)
    }
}

/// The glyph height that scales a gap.
fn glyph_height(item: &LayoutItem, line: &Line<'_>) -> f64 {
    if line.vertical { item.width } else { item.height }
}

/// Helvetica advance widths (per 1000 em) for U+0020..U+007E. A text run comes back as one box, so a match inside it
/// is placed by the share of the run's width its characters take; equal shares put a mark a letter off in
/// proportional type, and these metrics are close to any Latin body face.
const HELVETICA_WIDTHS: [u32; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584,
    556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278,
    469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260,
    334, 584,
];

/// Hangul, CJK, and fullwidth forms take a full em; other scripts about a Latin letter.
fn is_wide_code(code: u32) -> bool {
    (0x1100..=0x11ff).contains(&code)
        || (0x2e80..=0x9fff).contains(&code)
        || (0xac00..=0xd7af).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
        || (0xff00..=0xff60).contains(&code)
        || code >= 0x20000
}

fn glyph_weight(code: u32) -> u32 {
    if (32..=126).contains(&code) {
        return HELVETICA_WIDTHS[(code - 32) as usize];
    }
    if code < 32 || (0xdc00..=0xdfff).contains(&code) {
        return 0;
    }
    if is_wide_code(code) { 1000 } else { 556 }
}

/// `text.codePointAt(index)` over UTF-16 units.
fn code_point_at(units: &[u16], index: usize) -> u32 {
    let unit = u32::from(units[index]);
    if (0xd800..0xdc00).contains(&unit)
        && let Some(next) = units.get(index + 1)
        && (0xdc00..0xe000).contains(&u32::from(*next))
    {
        return 0x10000 + ((unit - 0xd800) << 10) + (u32::from(*next) - 0xdc00);
    }
    unit
}

fn run_weight(units: &[u16], from: usize, to: usize) -> u32 {
    (from..to).map(|index| glyph_weight(code_point_at(units, index))).sum()
}

/// A run of a line: the item, its text as UTF-16 units and where it sits in the line's text.
struct Span<'a> {
    item: &'a LayoutItem,
    units: Vec<u16>,
    start: usize,
    end: usize,
}

fn match_box(spans: &[Span<'_>], start: usize, end: usize, vertical: bool, reversed: bool) -> Rect {
    let (mut left, mut right, mut top, mut bottom) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for span in spans {
        let from = start.max(span.start);
        let to = end.min(span.end);
        if from >= to {
            continue;
        }
        let item = span.item;
        let total = f64::from(run_weight(&span.units, 0, span.units.len()).max(1));
        let shares = [f64::from(run_weight(&span.units, 0, from - span.start)) / total, f64::from(run_weight(&span.units, 0, to - span.start)) / total];
        // The match's share of the run, measured along the reading direction (from the far end when the run is
        // reversed); the other axis is the run's.
        let along = |origin: f64, length: f64| shares.map(|share| if reversed { origin + length - length * share } else { origin + length * share });
        if vertical {
            let [first, second] = along(item.top, item.height);
            top = js_min(top, js_min(first, second));
            bottom = js_max(bottom, js_max(first, second));
            left = js_min(left, item.x);
            right = js_max(right, item.x + item.width);
        } else {
            let [first, second] = along(item.x, item.width);
            left = js_min(left, js_min(first, second));
            right = js_max(right, js_max(first, second));
            top = js_min(top, item.top);
            bottom = js_max(bottom, item.top + item.height);
        }
    }
    Rect { x: round2(left), top: round2(top), width: round2(right - left), height: round2(bottom - top) }
}

/// UTF-16 offsets of the byte offsets of a string.
struct Utf16Index {
    at: Vec<usize>,
}

impl Utf16Index {
    fn new(text: &str) -> Self {
        let mut at = vec![0; text.len() + 1];
        let mut unit = 0;
        for (byte, c) in text.char_indices() {
            at[byte] = unit;
            unit += c.len_utf16();
        }
        at[text.len()] = unit;
        Utf16Index { at }
    }

    fn unit(&self, byte: usize) -> usize {
        self.at[byte]
    }
}

/// Literal occurrences by search on the case-folded line; a pattern runs on the original text, case-insensitively.
/// Empty pattern matches are skipped.
fn occurrences<'a>(text: &'a str, haystack: &'a str, target: &'a str, pattern: Option<&'a JsRegex>) -> Box<dyn Iterator<Item = (usize, usize)> + 'a> {
    if let Some(pattern) = pattern {
        let index = Utf16Index::new(text);
        return Box::new(pattern.find_iter(text).filter(|found| found.end > found.start).map(move |found| (index.unit(found.start), index.unit(found.end))));
    }
    let index = Utf16Index::new(haystack);
    let mut from = 0usize;
    Box::new(std::iter::from_fn(move || {
        if from + target.len() > haystack.len() {
            return None;
        }
        let start = from + haystack[from..].find(target)?;
        let end = start + target.len();
        from = end;
        Some((index.unit(start), index.unit(end)))
    }))
}

/// pdf.js hands text back as runs, and a phrase often spans several. Each line is joined into one string that
/// remembers which run owns every character, so a match maps back to a box by the share of each run it covers.
struct Row<'a> {
    vertical: bool,
    reversed: bool,
    text: String,
    units: Vec<u16>,
    spans: Vec<Span<'a>>,
}

fn row_of<'a>(line: &Line<'a>) -> Row<'a> {
    let mut text = String::new();
    let mut spans: Vec<Span<'a>> = Vec::new();
    let mut length = 0usize;
    for &item in &line.items {
        // A gap wider than a third of the glyph height is a word break the runs did not carry.
        if let Some(previous) = spans.last() {
            let gap = run_gap(previous.item, item, line);
            if gap > glyph_height(item, line) / 3.0 && !text.chars().next_back().is_some_and(is_js_space) && !item.text.chars().next().is_some_and(is_js_space)
            {
                text.push(' ');
                length += 1;
            }
        }
        let units: Vec<u16> = item.text.encode_utf16().collect();
        spans.push(Span { item, start: length, end: length + units.len(), units });
        length += spans.last().map_or(0, |span| span.units.len());
        text.push_str(&item.text);
    }
    let units = text.encode_utf16().collect();
    Row { vertical: line.vertical, reversed: line.reversed, text, units, spans }
}

const REGEXP_SPECIAL: &str = ".*+?^${}()|[]\\";

/// A phrase the caller names as one string may sit on two lines in the page: the wrap ate the space in Latin text, and
/// needed none between wide glyphs. This turns the phrase into a pattern that reads across one line break either way:
/// whitespace spans the break, and a break may fall between two wide characters.
fn wrap_tolerant_pattern(needle: &str) -> Result<JsRegex, AnalysisError> {
    let chars: Vec<char> = needle.chars().collect();
    let mut source = String::new();
    let mut previous: Option<char> = None;
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if is_js_space(current) {
            while index + 1 < chars.len() && is_js_space(chars[index + 1]) {
                index += 1;
            }
            source.push_str("\\s+");
            previous = Some(' ');
            index += 1;
            continue;
        }
        if let Some(before) = previous
            && before != ' '
            && is_wide_code(u32::from(before))
            && is_wide_code(u32::from(current))
        {
            source.push_str("\\n?");
        }
        if REGEXP_SPECIAL.contains(current) {
            source.push('\\');
        }
        source.push(current);
        previous = Some(current);
        index += 1;
    }
    JsRegex::new(&source, "giu").map_err(AnalysisError::plain)
}

static WORD_CHARACTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[\p{L}\p{N}]", "u"));

/// `/[\p{L}\p{N}]/u.test(text[i])`: the test sees one code unit, so half of a surrogate pair is no letter.
fn is_word_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(|c| WORD_CHARACTER.is_match(c.encode_utf8(&mut [0; 4])))
}

/// Matches that cross a line break, measured one box per line, the shape a highlighter draws. Lines join with a newline
/// so a match maps back to the row that owns each character; single-line hits belong to the plain pass.
fn cross_line_matches(
    page: &PageLayout,
    rows: &[Row<'_>],
    needle: &str,
    bounded: &dyn Fn(&[u16], usize, usize) -> bool,
) -> Result<Vec<SearchMatch>, AnalysisError> {
    if rows.len() < 2 {
        return Ok(Vec::new());
    }
    let mut stream = String::new();
    let mut units: Vec<u16> = Vec::new();
    let mut placed: Vec<usize> = Vec::new();
    for row in rows {
        if !stream.is_empty() {
            stream.push('\n');
            units.push(10);
        }
        placed.push(units.len());
        stream.push_str(&row.text);
        units.extend(&row.units);
    }
    let pattern = wrap_tolerant_pattern(needle)?;
    let index = Utf16Index::new(&stream);
    let mut found = Vec::new();
    for range in pattern.find_iter(&stream) {
        let matched = &stream[range.clone()];
        let (start, end) = (index.unit(range.start), index.unit(range.end));
        if !matched.contains('\n') || !bounded(&units, start, end) {
            continue;
        }
        let mut rects = Vec::new();
        for (row, origin) in rows.iter().zip(&placed) {
            let from = start.saturating_sub(*origin);
            let to = end.saturating_sub(*origin).min(row.units.len());
            if from >= to {
                continue;
            }
            rects.push(match_box(&row.spans, from, to, row.vertical, row.reversed));
        }
        if rects.len() < 2 {
            continue;
        }
        let text = collapse_spaces(matched);
        found.push(SearchMatch { page: page.page, line: slice_utf16(&text, 200), text, rect: rects[0], rects: Some(rects) });
    }
    Ok(found)
}

/// `findPdfText(layout, query, { limit, wholeWord, regex })`: substring (case-insensitive), whole word, or a regular
/// expression, over the lines of every page; a phrase that wraps across lines is found with one box per line.
pub fn find_pdf_text(layout: &PdfLayout, query: &str, options: &SearchOptions) -> Result<SearchResult, AnalysisError> {
    let raw = js_trim(query);
    let needle = if options.regex { raw.to_owned() } else { collapse_spaces(raw) };
    if needle.is_empty() {
        return Err(AnalysisError::plain("PDF text search needs query text"));
    }
    let pattern = if options.regex {
        Some(JsRegex::new(&needle, "giu").map_err(|message| AnalysisError::plain(format!("PDF text search pattern is invalid: {message}")))?)
    } else {
        None
    };
    let needle_lower = js_to_lowercase(&needle);
    let whole_word = options.whole_word;
    let bounded = move |units: &[u16], start: usize, end: usize| {
        !whole_word || ((start == 0 || !is_word_unit(units[start - 1])) && (end >= units.len() || !is_word_unit(units[end])))
    };
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut truncated = false;
    for page in &layout.pages {
        let rows: Vec<Row<'_>> = layout_lines(page).iter().map(row_of).collect();
        for row in &rows {
            // Lower-casing can change a string's length (İ becomes i and a combining dot); match exactly when it does.
            let folded = js_to_lowercase(&row.text);
            let exact = utf16_len(&folded) != row.units.len();
            let (haystack, target) = if exact { (row.text.as_str(), needle.as_str()) } else { (folded.as_str(), needle_lower.as_str()) };
            for (start, end) in occurrences(&row.text, haystack, target, pattern.as_ref()) {
                if matches.len() >= options.limit {
                    truncated = true;
                    break;
                }
                if bounded(&row.units, start, end) {
                    matches.push(SearchMatch {
                        page: page.page,
                        text: String::from_utf16_lossy(&row.units[start..end]),
                        line: slice_utf16(js_trim(&row.text), 200),
                        rect: match_box(&row.spans, start, end, row.vertical, row.reversed),
                        rects: None,
                    });
                }
            }
            if truncated {
                break;
            }
        }
        if truncated {
            break;
        }
        // A wrapped phrase is a literal one: a pattern keeps its own line semantics.
        if pattern.is_none() {
            for found in cross_line_matches(page, &rows, &needle, &bounded)? {
                if matches.len() >= options.limit {
                    truncated = true;
                    break;
                }
                matches.push(found);
            }
        }
        if truncated {
            break;
        }
    }
    Ok(SearchResult { query: needle, matches, truncated })
}

impl Rect {
    fn pairs(&self) -> Vec<(&'static str, Value)> {
        vec![("x", json_number(self.x)), ("top", json_number(self.top)), ("width", json_number(self.width)), ("height", json_number(self.height))]
    }

    pub fn to_json(&self) -> Value {
        object(self.pairs())
    }
}

impl SearchMatch {
    pub fn to_json(&self) -> Value {
        let mut pairs = vec![("page", Value::from(self.page)), ("text", Value::from(self.text.clone())), ("line", Value::from(self.line.clone()))];
        pairs.extend(self.rect.pairs());
        if let Some(rects) = &self.rects {
            pairs.push(("rects", Value::Array(rects.iter().map(Rect::to_json).collect())));
        }
        object(pairs)
    }
}

impl SearchResult {
    pub fn to_json(&self) -> Value {
        object(vec![
            ("query", Value::from(self.query.clone())),
            ("matchCount", Value::from(self.matches.len())),
            ("matches", Value::Array(self.matches.iter().map(SearchMatch::to_json).collect())),
            ("truncated", Value::Bool(self.truncated)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, x: f64, top: f64, width: f64) -> LayoutItem {
        LayoutItem { text: text.to_owned(), x, top, width, height: 10.0, vertical: false, reversed: false, direction: "ltr".to_owned(), font: String::new() }
    }

    fn layout(items: Vec<LayoutItem>) -> PdfLayout {
        let page = PageLayout {
            page: 1,
            width: 612.0,
            height: 792.0,
            origin: None,
            transform: [1.0, 0.0, 0.0, -1.0, 0.0, 792.0],
            items,
            lines: Vec::new(),
            boxes: Vec::new(),
            shapes_unavailable: None,
            links: Vec::new(),
        };
        PdfLayout { page_count: 1, pages: vec![page], truncated: false }
    }

    fn find(layout: &PdfLayout, query: &str) -> SearchResult {
        find_pdf_text(layout, query, &SearchOptions::default()).expect("a search")
    }

    #[test]
    fn the_weight_table_has_every_printable_ascii_character() {
        assert_eq!(glyph_weight(32), 278);
        assert_eq!(glyph_weight(u32::from('W')), 944);
        assert_eq!(glyph_weight(126), 584);
        assert_eq!(glyph_weight(10), 0);
        assert_eq!(glyph_weight(0xdc00), 0);
        assert_eq!(glyph_weight(0xe9), 556);
        assert_eq!(glyph_weight(0xd55c), 1000);
        assert_eq!(glyph_weight(0x1f600), 556);
        assert_eq!(glyph_weight(0x20000), 1000);
    }

    #[test]
    fn a_literal_match_is_case_insensitive_and_placed_by_glyph_widths() {
        let result = find(&layout(vec![run("Hello World", 100.0, 50.0, 110.0)]), "world");
        assert_eq!(result.query, "world");
        assert_eq!(result.matches.len(), 1);
        let hit = &result.matches[0];
        assert_eq!((hit.text.as_str(), hit.line.as_str()), ("World", "Hello World"));
        // The match starts where "Hello " ends: its share of the run's width is the share of the glyph weights.
        let total: f64 = "Hello World".chars().map(|c| f64::from(glyph_weight(u32::from(c)))).sum();
        let before: f64 = "Hello ".chars().map(|c| f64::from(glyph_weight(u32::from(c)))).sum();
        assert_eq!(hit.rect.x, round2(100.0 + 110.0 * (before / total)));
        assert_eq!((hit.rect.top, hit.rect.height), (50.0, 10.0));
    }

    #[test]
    fn runs_with_a_gap_are_joined_with_a_space_so_a_phrase_spans_them() {
        let items = vec![run("annual", 100.0, 50.0, 40.0), run("report", 150.0, 50.0, 40.0)];
        let result = find(&layout(items), "annual report");
        assert_eq!(result.matches.len(), 1);
        let rect = result.matches[0].rect;
        assert_eq!((rect.x, rect.width), (100.0, 90.0));
        // No gap: the runs are one word.
        let touching = vec![run("annual", 100.0, 50.0, 40.0), run("report", 140.0, 50.0, 40.0)];
        assert!(find(&layout(touching.clone()), "annual report").matches.is_empty());
        assert_eq!(find(&layout(touching), "annualreport").matches.len(), 1);
    }

    #[test]
    fn a_whole_word_match_needs_non_letters_around_it() {
        let items = vec![run("cat concatenate cat.", 10.0, 10.0, 200.0)];
        let options = SearchOptions { whole_word: true, ..SearchOptions::default() };
        let result = find_pdf_text(&layout(items.clone()), "cat", &options).unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!(find(&layout(items), "cat").matches.len(), 3);
        let accented = vec![run("café", 10.0, 10.0, 40.0)];
        assert!(find_pdf_text(&layout(accented), "caf", &options).unwrap().matches.is_empty());
    }

    #[test]
    fn a_regular_expression_runs_on_the_original_text_without_a_wrapped_pass() {
        let items = vec![run("Invoice 2024-001 and invoice 2025-002", 10.0, 10.0, 300.0)];
        let options = SearchOptions { regex: true, ..SearchOptions::default() };
        let result = find_pdf_text(&layout(items), r"invoice \d{4}-\d+", &options).unwrap();
        let found: Vec<&str> = result.matches.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(found, ["Invoice 2024-001", "invoice 2025-002"]);
        let bad = find_pdf_text(&layout(Vec::new()), "(", &options).unwrap_err();
        assert!(bad.message.starts_with("PDF text search pattern is invalid: Invalid regular expression"), "{}", bad.message);
    }

    #[test]
    fn a_phrase_wrapped_over_two_lines_has_one_box_per_line() {
        let items = vec![run("the quick brown", 72.0, 100.0, 90.0), run("fox jumps over", 72.0, 112.0, 85.0)];
        let result = find(&layout(items), "brown fox");
        assert_eq!(result.matches.len(), 1);
        let hit = &result.matches[0];
        assert_eq!(hit.text, "brown fox");
        let rects = hit.rects.as_ref().expect("a box per line");
        assert_eq!(rects.len(), 2);
        assert!(rects[0].top < rects[1].top);
        assert_eq!(hit.rect, rects[0]);
        assert!(hit.to_json()["rects"].is_array());
    }

    #[test]
    fn a_wrap_between_wide_characters_needs_no_space() {
        let items = vec![run("\u{d55c}\u{ad6d}", 72.0, 100.0, 20.0), run("\u{c5b4}\u{d55c}", 72.0, 112.0, 20.0)];
        let result = find(&layout(items), "\u{d55c}\u{ad6d}\u{c5b4}");
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].rects.as_ref().map(Vec::len), Some(2));
    }

    #[test]
    fn the_limit_stops_the_search_and_says_so() {
        let items = vec![run("a a a a a", 10.0, 10.0, 90.0)];
        let options = SearchOptions { limit: 2, ..SearchOptions::default() };
        let result = find_pdf_text(&layout(items.clone()), "a", &options).unwrap();
        assert_eq!((result.matches.len(), result.truncated), (2, true));
        let exact = find_pdf_text(&layout(items), "a", &SearchOptions { limit: 5, ..SearchOptions::default() }).unwrap();
        assert_eq!((exact.matches.len(), exact.truncated), (5, false));
    }

    #[test]
    fn an_empty_query_is_an_error_and_inner_white_space_is_one_space() {
        let error = find_pdf_text(&layout(Vec::new()), " \u{a0} ", &SearchOptions::default()).unwrap_err();
        assert_eq!(error.message, "PDF text search needs query text");
        let result = find(&layout(vec![run("second line", 10.0, 10.0, 80.0)]), "  second \n  line ");
        assert_eq!(result.query, "second line");
        assert_eq!(result.matches.len(), 1);
    }

    #[test]
    fn reversed_text_on_a_rotated_page_is_measured_from_its_far_end() {
        let mut item = run("abcd", 100.0, 200.0, 12.0);
        item.vertical = true;
        item.reversed = true;
        item.height = 40.0;
        let result = find(&layout(vec![item]), "ab");
        let rect = result.matches[0].rect;
        // Reading upward: the first letters sit at the bottom of the run's box (200 to 240).
        assert!(rect.top > 210.0);
        assert!((rect.top + rect.height - 240.0).abs() < 0.011);
        assert_eq!((rect.x, rect.width), (100.0, 12.0));
    }

    #[test]
    fn the_json_matches_node_s_shape() {
        let result = find(&layout(vec![run("one two", 10.0, 10.0, 70.0)]), "two");
        let json = result.to_json();
        assert_eq!(json["matchCount"], 1);
        assert_eq!(json["matches"][0]["text"], "two");
        assert!(json["matches"][0].get("rects").is_none());
        assert_eq!(json["truncated"], false);
    }
}
