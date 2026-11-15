//! The table layout and the row measurement against the recording of the Node product's: `tests/goldens/tables.json`,
//! written by `tests/recorders/record-tables.mjs` from `buildTableRender`, `measureMarkdownTableRows`,
//! `measureMarkdownRenderedRows` and `wrappedLineRows` over the tables of `tests/corpus` and a seeded set of generated
//! tables, at the widths 10..200 step 5. The lines must be the same bytes. The recorder's `--check` run says whether the
//! recording is still the tree's code; these tests say whether this crate lays out and measures the same.
//!
//! The invariant the product relies on is asserted too: the rows measured are the rows painted (the lines the renderer
//! lays out, each counted by its wrapped rows).

use std::path::Path;
#[allow(clippy::disallowed_types, reason = "test: the ignored live check runs the Node recorder as a child process")]
use std::process::Command;
use std::sync::Once;

use mixdog_markdown_ansi::lexer::Token;
use mixdog_markdown_ansi::measure::{measure_markdown_rendered_rows, wrapped_line_rows};
use mixdog_markdown_ansi::render::{RenderOptions, render_markdown_ansi, render_token_ansi_segments};
use mixdog_markdown_ansi::table::{assistant_body_width, build_table_layout, measure_markdown_table_rows};
use mixdog_termtext::grapheme::utf16_to_byte;
use mixdog_termtext::strip_ansi;
use mixdog_tui_style::set_theme;
use serde_json::Value;
use sha2::{Digest, Sha256};

const GOLDEN: &str = include_str!("goldens/tables.json");
const STRINGS: &str = include_str!("corpus/strings.json");
const EDGE: &str = include_str!("corpus/edge.json");
const DOCS: &str = include_str!("corpus/docs.json");
const SHOWN: usize = 12;

/// The recording fixes the display-width policy off; this process resolves its own once, at the first width it measures.
fn fix_policy() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: nothing else in this test binary reads or writes the environment, and no width was measured yet.
        unsafe { std::env::set_var("MIXDOG_TUI_AMBIGUOUS_WIDE", "0") };
    });
}

fn parse(text: &str) -> Value {
    serde_json::from_str(&read_lone_surrogates(text)).unwrap_or_else(|error| panic!("a recorded file does not parse: {error}"))
}

fn entries(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn numbers(value: &Value) -> Vec<usize> {
    entries(value).iter().map(|n| n.as_u64().unwrap_or(0) as usize).collect()
}

/// The first 16 hex digits of the SHA-256 of the lines joined by U+0000.
fn digest(lines: &[String]) -> String {
    let bytes = Sha256::digest(lines.join("\u{0}").as_bytes());
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out.truncate(16);
    out
}

fn clip(text: &str) -> String {
    let mut shown: String = text.chars().take(100).collect();
    if text.chars().count() > 100 {
        shown.push_str("...");
    }
    shown
}

fn report(failures: &mut Vec<String>) {
    let more = failures.len().saturating_sub(SHOWN);
    failures.truncate(SHOWN);
    assert!(failures.is_empty(), "differences (first {SHOWN}):\n{}\n... and {more} more", failures.join("\n"));
}

/// The table token a raw table text lexes to.
fn table_token(raw: &str) -> Token {
    let segments = render_token_ansi_segments(raw, RenderOptions { width: 80, trim_partial_fences: false });
    let segment = segments.iter().find(|segment| segment.is_table()).unwrap_or_else(|| panic!("no table in {raw:?}"));
    segment.token().clone()
}

/// The long recorded comparisons are cut into this many slices; a case belongs to the slice its index in the recording
/// is congruent to, so every case runs in exactly one slice and the slices cost about the same.
const SLICES: usize = 16;

fn in_slice(index: usize, slice: usize) -> bool {
    index % SLICES == slice
}

/// How many of `total` cases fall in `slice`.
fn slice_cases(total: usize, slice: usize) -> usize {
    (0..total).filter(|index| in_slice(*index, slice)).count()
}

fn check_the_table_layout(slice: usize) {
    fix_policy();
    let golden = parse(GOLDEN);
    let widths = numbers(&golden["widths"]);
    let tables = entries(&golden["tables"]);
    assert!(widths.len() > 30 && tables.len() > 100, "tests/goldens/tables.json is not recorded: node tests/recorders/record-tables.mjs --tree C:/Project/mixdog --write tests/goldens/tables.json");
    let mut failures: Vec<String> = Vec::new();
    let mut cases = 0;
    for (theme_at, theme) in entries(&golden["themes"]).iter().enumerate() {
        set_theme(theme.as_str().unwrap_or(""));
        for (entry_at, entry) in tables.iter().enumerate().filter(|(index, _)| in_slice(*index, slice)) {
            cases += 1;
            let id = str_of(entry, "id");
            let token = table_token(str_of(entry, "raw"));
            let want_digests = entry["themes"][theme_at].as_str().unwrap_or("");
            let want_vertical = str_of(entry, "vertical");
            let want_rows = numbers(&entry["rows"]);
            for (at, width) in widths.iter().enumerate() {
                let built = build_table_layout(&token, *width);
                let want = want_digests.get(at * 16..at * 16 + 16).unwrap_or("");
                if digest(&built.lines) != want {
                    failures.push(format!("{id} under theme {theme_at} at width {width}: the lines differ"));
                    continue;
                }
                if theme_at == 0 {
                    let vertical = if built.use_vertical_format { "1" } else { "0" };
                    if want_vertical.get(at..at + 1) != Some(vertical) {
                        failures.push(format!("{id} at width {width}: vertical fallback is {vertical}, recorded {want_vertical:?}"));
                    }
                    if want_rows.get(at) != Some(&built.lines.len()) {
                        failures.push(format!("{id} at width {width}: {} lines, recorded {:?}", built.lines.len(), want_rows.get(at)));
                    }
                }
                // The invariant: the rows measured are the lines laid out.
                if measure_markdown_table_rows(&token, *width) != built.lines.len() {
                    failures.push(format!("{id} at width {width}: the measured rows are not the lines laid out"));
                }
            }
            // A few tables are recorded line by line, so a difference reads.
            for (key, lines) in entry["sample"].as_object().into_iter().flatten().filter(|_| theme_at == 0) {
                let width: usize = key.trim_start_matches('w').parse().unwrap_or(0);
                let got = build_table_layout(&token, width).lines;
                let same = got.len() == entries(lines).len()
                    && got.iter().zip(entries(lines)).all(|(a, b)| Some(a.as_str()) == b.as_str());
                if !same {
                    let at = got.iter().zip(entries(lines)).position(|(a, b)| Some(a.as_str()) != b.as_str()).unwrap_or(0);
                    failures.push(format!("{id} at {key}: line {at}: got {:?}", clip(got.get(at).map_or("", String::as_str))));
                }
            }
        }
    }
    report(&mut failures);
    let themes = entries(&golden["themes"]).len();
    println!("table layout slice {slice}: {cases} table-theme cases of {}", slice_cases(tables.len(), slice) * themes);
    assert_eq!(cases, slice_cases(tables.len(), slice) * themes, "every table of the slice ran under every theme");
}

#[test]
fn the_slices_cover_every_recorded_case_once() {
    let golden = parse(GOLDEN);
    for total in [entries(&golden["tables"]).len(), entries(&golden["measured"]).len()] {
        let sliced: usize = (0..SLICES).map(|slice| slice_cases(total, slice)).sum();
        assert_eq!(sliced, total);
        println!("{total} cases in {SLICES} slices");
    }
}

fn corpus_text<'a>(corpus: &'a [(&str, Value)], group: &str, id: &str) -> Option<&'a str> {
    let (_, list) = corpus.iter().find(|(name, _)| *name == group)?;
    entries(list).iter().find(|entry| str_of(entry, "id") == id).map(|entry| str_of(entry, "text"))
}

/// The rows the renderer paints for `text` at `columns`: the lines it lays out, each counted by its wrapped rows. A
/// U+FFFD in these tables is half of a surrogate pair Node cut (the texts hold no other): Node measures its own line, which
/// holds the half, as no cell, so the half is measured as the carrier of it, not as the replacement character it is
/// written as.
fn painted_rows(text: &str, columns: usize) -> usize {
    if text.is_empty() {
        return 1;
    }
    let width = assistant_body_width(columns);
    let carrier = mixdog_termtext::lone::carrier_of(0xd83d);
    let rows: usize = render_markdown_ansi(text, width).iter().map(|line| wrapped_line_rows(&strip_ansi(line).replace('�', &carrier.to_string()), width)).sum();
    rows.max(1)
}

fn check_the_row_measurement(slice: usize) {
    fix_policy();
    let golden = parse(GOLDEN);
    let corpus = [("strings", parse(STRINGS)), ("edge", parse(EDGE)), ("docs", parse(DOCS))];
    let whole_columns = numbers(&golden["measureColumns"]);
    let prefix_columns = numbers(&golden["prefixColumns"]);
    let measured = entries(&golden["measured"]);
    assert!(measured.len() > 300, "tests/goldens/tables.json holds no measurement");
    let mut failures: Vec<String> = Vec::new();
    let mut cases = 0;
    for (_, entry) in measured.iter().enumerate().filter(|(index, _)| in_slice(*index, slice)) {
        cases += 1;
        let (group, id) = (str_of(entry, "group"), str_of(entry, "id"));
        let Some(text) = corpus_text(&corpus, group, id) else {
            failures.push(format!("{group} {id} is not a corpus input"));
            continue;
        };
        for (columns, want) in whole_columns.iter().zip(numbers(&entry["whole"])) {
            let got = measure_markdown_rendered_rows(text, *columns, false);
            if got != want {
                failures.push(format!("{group} {id} at {columns} columns: {got} rows, recorded {want}"));
            }
            // Painted rows are checked on every input that is not the one huge document.
            if text.len() < 20_000 && painted_rows(text, *columns) != got {
                failures.push(format!("{group} {id} at {columns} columns: the measured rows are not the painted rows"));
            }
        }
        let prefixes = numbers(&entry["prefixes"]);
        let mut at = 0;
        for cut in numbers(&entry["cuts"]) {
            let part = &text[..utf16_to_byte(text, cut)];
            for columns in &prefix_columns {
                for trim in [false, true] {
                    let got = measure_markdown_rendered_rows(part, *columns, trim);
                    if prefixes.get(at) != Some(&got) {
                        failures.push(format!(
                            "{group} {id} prefix of {cut} units at {columns} columns (trim {trim}): {got} rows, recorded {:?}",
                            prefixes.get(at)
                        ));
                    }
                    at += 1;
                }
            }
        }
    }
    report(&mut failures);
    println!("row measurement slice {slice}: {cases} recorded inputs");
    assert_eq!(cases, slice_cases(measured.len(), slice));
}

macro_rules! slices {
    ($($layout:ident, $rows:ident = $slice:expr);* $(;)?) => {
        $(
            #[test]
            fn $layout() {
                check_the_table_layout($slice);
            }

            #[test]
            fn $rows() {
                check_the_row_measurement($slice);
            }
        )*
    };
}

slices!(
    the_table_layout_equals_the_node_one_byte_for_byte_slice_0, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_0 = 0;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_1, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_1 = 1;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_2, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_2 = 2;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_3, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_3 = 3;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_4, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_4 = 4;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_5, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_5 = 5;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_6, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_6 = 6;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_7, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_7 = 7;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_8, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_8 = 8;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_9, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_9 = 9;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_10, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_10 = 10;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_11, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_11 = 11;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_12, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_12 = 12;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_13, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_13 = 13;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_14, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_14 = 14;
    the_table_layout_equals_the_node_one_byte_for_byte_slice_15, the_row_measurement_equals_the_node_one_and_the_painted_rows_slice_15 = 15;
);


#[test]
fn the_painted_rows_of_wide_cells_and_fallbacks_are_the_measured_ones() {
    fix_policy();
    let golden = parse(GOLDEN);
    let mut failures: Vec<String> = Vec::new();
    for entry in entries(&golden["tables"]) {
        let raw = str_of(entry, "raw");
        for columns in [13, 25, 43, 83, 203] {
            let got = measure_markdown_rendered_rows(raw, columns, false);
            if painted_rows(raw, columns) != got {
                failures.push(format!("{} at {columns} columns: {got} rows are not the painted rows", str_of(entry, "id")));
            }
        }
    }
    report(&mut failures);
}

#[test]
fn wrapped_line_rows_equal_the_node_ones() {
    fix_policy();
    let golden = parse(GOLDEN);
    let widths = numbers(&golden["wrapWidths"]);
    let lines = entries(&golden["wrapLines"]);
    assert!(lines.len() > 100, "tests/goldens/tables.json holds no wrapped lines");
    let mut failures: Vec<String> = Vec::new();
    for (line, rows) in lines.iter().zip(entries(&golden["wrapped"])) {
        let line = line.as_str().unwrap_or("");
        for (width, want) in widths.iter().zip(numbers(rows)) {
            let got = wrapped_line_rows(line, *width);
            if got != want {
                failures.push(format!("{:?} at width {width}: {got} rows, recorded {want}", clip(line)));
            }
        }
    }
    report(&mut failures);
}

#[test]
#[ignore = "runs node over the reference checkout C:/Project/mixdog (read only)"]
#[allow(clippy::disallowed_types, reason = "test: runs the Node recorder as a child process")]
fn live_tables_golden_matches_the_node_layout() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new("node")
        .arg(crate_dir.join("tests/recorders/record-tables.mjs"))
        .args(["--tree", "C:/Project/mixdog", "--check"])
        .arg(crate_dir.join("tests/goldens/tables.json"))
        .status()
        .expect("node runs");
    assert!(status.success(), "the recorder found the golden different from a fresh recording");
}

fn hex4(digits: &[u8]) -> Option<u32> {
    std::str::from_utf8(digits).ok().and_then(|text| u32::from_str_radix(text, 16).ok())
}

/// A recorded string may hold half of a surrogate pair (Node cuts a string by UTF-16 unit): JSON text writes that as a lone
/// `\ud83d`, which a Rust string cannot hold. Each lone half is read as U+FFFD, which is also what the recorder's SHA-256 over
/// UTF-8 saw. Such a value is still compared exactly, as the U+FFFD it was read as.
fn read_lone_surrogates(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut at, mut copied) = (0, 0);
    while at < bytes.len() {
        if bytes[at] != b'\x5c' {
            at += 1;
            continue;
        }
        let unit = if bytes.get(at + 1) == Some(&b'u') && at + 6 <= bytes.len() { hex4(&bytes[at + 2..at + 6]) } else { None };
        let Some(unit) = unit else {
            at += 2;
            continue;
        };
        let low_follows = |from: usize| {
            bytes.get(from) == Some(&b'\x5c')
                && bytes.get(from + 1) == Some(&b'u')
                && from + 6 <= bytes.len()
                && hex4(&bytes[from + 2..from + 6]).is_some_and(|low| (0xDC00..0xE000).contains(&low))
        };
        if (0xD800..0xDC00).contains(&unit) && low_follows(at + 6) {
            at += 12;
        } else if (0xD800..0xE000).contains(&unit) {
            out.push_str(&text[copied..at]);
            out.push_str("\\ufffd");
            at += 6;
            copied = at;
        } else {
            at += 6;
        }
    }
    out.push_str(&text[copied..]);
    out
}
