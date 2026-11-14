//! The twin of `string-width` 8.3.0, the display-width policy and `strip-ansi` 7.2.0: every row of
//! `goldens/width.json` (recorded by `tests/recorders/record-width.mjs` from the Node code over the corpus) is
//! measured by the Rust port and must give the same numbers and the same stripped text.

use mixdog_termtext::policy::display_width_with;
use mixdog_termtext::width::{StringWidthOptions, string_width};
use mixdog_termtext::width_tables::{
    AMBIGUOUS, EXTENDED_PICTOGRAPHIC, NOT_VISIBLE, RGI_SEQUENCES, RGI_SINGLE, SPACING_MARK, WIDE,
};
use mixdog_termtext::strip_ansi;
use unicode_segmentation::UnicodeSegmentation;

const GOLDEN: &str = include_str!("goldens/width.json");
const SHOWN: usize = 12;

fn number(row: &[serde_json::Value], at: usize) -> usize {
    row[at].as_u64().and_then(|n| usize::try_from(n).ok()).expect("a width")
}

#[test]
fn every_recorded_row_gives_the_same_answer() {
    let golden: serde_json::Value = serde_json::from_str(GOLDEN).expect("the golden parses");
    let rows = golden["rows"].as_array().expect("rows");
    assert!(rows.len() > 5000, "the corpus is the recorded one");
    let narrow = StringWidthOptions::default();
    let ambiguous_wide = StringWidthOptions { ambiguous_is_narrow: false, ..narrow };
    let counted = StringWidthOptions { count_ansi_escape_codes: true, ..narrow };
    let mut failures = Vec::new();
    for row in rows {
        let row = row.as_array().expect("a row");
        let text = row[0].as_str().expect("text");
        let got = [
            string_width(text, narrow),
            string_width(text, ambiguous_wide),
            string_width(text, counted),
            display_width_with(text, true),
            display_width_with(text, false),
        ];
        let want = [number(row, 1), number(row, 2), number(row, 3), number(row, 4), number(row, 5)];
        let stripped = strip_ansi(text);
        let clusters = text.graphemes(true).count();
        if got != want || stripped != row[6].as_str().expect("stripped") || clusters != number(row, 7) {
            failures.push(format!("{text:?}: got {got:?} {stripped:?} {clusters}, recorded {want:?} {} {}", row[6], row[7]));
        }
    }
    let shown: Vec<_> = failures.iter().take(SHOWN).collect();
    assert!(failures.is_empty(), "{} of {} rows differ, first {SHOWN}: {shown:#?}", failures.len(), rows.len());
}

fn sorted_ranges(name: &str, ranges: &[(u32, u32)]) {
    for pair in ranges.windows(2) {
        assert!(pair[0].1 < pair[1].0, "{name}: {:x?} is not before {:x?}", pair[0], pair[1]);
    }
    assert!(ranges.iter().all(|&(lo, hi)| lo <= hi && hi <= 0x10ffff), "{name}: a range is inverted");
}

#[test]
fn the_tables_are_sorted_for_binary_search() {
    for (name, table) in [
        ("WIDE", WIDE),
        ("AMBIGUOUS", AMBIGUOUS),
        ("NOT_VISIBLE", NOT_VISIBLE),
        ("SPACING_MARK", SPACING_MARK),
        ("EXTENDED_PICTOGRAPHIC", EXTENDED_PICTOGRAPHIC),
        ("RGI_SINGLE", RGI_SINGLE),
    ] {
        sorted_ranges(name, table);
    }
    assert!(RGI_SEQUENCES.windows(2).all(|pair| pair[0] < pair[1]), "RGI_SEQUENCES is not strictly sorted");
}

#[test]
fn ascii_text_is_not_segmented() {
    // A 4 MiB printable-ASCII text is its length without a walk over clusters: this finishes at once, and the
    // answer cannot differ from the length.
    let text = "abc def ".repeat(1 << 19);
    assert_eq!(string_width(&text, StringWidthOptions::default()), text.len());
    assert_eq!(display_width_with(&text, true), text.len());
}
