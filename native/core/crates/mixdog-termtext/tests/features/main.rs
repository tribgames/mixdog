//! What callers of the text measuring crate rely on: the width of mixed text, the tables behind it, and that wrapping,
//! slicing and truncating never exceed their budget or lose the text.

use mixdog_termtext::slice::slice_ansi;
use mixdog_termtext::strip_ansi;
use mixdog_termtext::truncate::{TruncatePosition, truncate};
use mixdog_termtext::width::{StringWidthOptions, string_width};
use mixdog_termtext::width_tables::{AMBIGUOUS, EXTENDED_PICTOGRAPHIC, NOT_VISIBLE, RGI_SINGLE, SPACING_MARK, WIDE};
use mixdog_termtext::wrap::{WrapOptions, wrap_ansi};

fn width(text: &str) -> usize {
    string_width(text, StringWidthOptions::default())
}

#[test]
fn the_range_tables_are_sorted_and_disjoint_so_binary_search_finds_every_member() {
    for (name, table) in [
        ("WIDE", WIDE),
        ("AMBIGUOUS", AMBIGUOUS),
        ("NOT_VISIBLE", NOT_VISIBLE),
        ("SPACING_MARK", SPACING_MARK),
        ("EXTENDED_PICTOGRAPHIC", EXTENDED_PICTOGRAPHIC),
        ("RGI_SINGLE", RGI_SINGLE),
    ] {
        for pair in table.windows(2) {
            assert!(pair[0].0 <= pair[0].1 && pair[0].1 < pair[1].0, "{name}: {:?} then {:?}", pair[0], pair[1]);
        }
    }
}

#[test]
fn text_is_measured_in_terminal_cells() {
    assert_eq!(width("abc"), 3);
    assert_eq!(width("\u{d55c}\u{ae00}"), 4, "hangul syllables take two cells each");
    assert_eq!(width("\u{4e2d}a"), 3);
    assert_eq!(width("e\u{301}"), 1, "a combining mark adds nothing");
    assert_eq!(width("\u{200b}"), 0, "a zero-width space is invisible");
    assert_eq!(width("\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}"), 2, "a family emoji is one two-cell cluster");
    assert_eq!(width("\u{1f600}"), 2);
}

#[test]
fn escape_sequences_take_no_cells_unless_counted_as_text() {
    assert_eq!(width("\x1b[31mred\x1b[39m"), 3);
    assert_eq!(
        string_width("\x1b[31m", StringWidthOptions { count_ansi_escape_codes: true, ..StringWidthOptions::default() }),
        4,
        "the bracket and digits count, the escape byte is a zero-width control"
    );
    assert_eq!(strip_ansi("\x1b[1mbold\x1b[22m \x1b]8;;http://x\x07link\x1b]8;;\x07"), "bold link");
}

#[test]
fn ambiguous_characters_are_narrow_unless_the_caller_asks_for_wide() {
    let text = "\u{00b1}";
    assert_eq!(width(text), 1);
    assert_eq!(string_width(text, StringWidthOptions { ambiguous_is_narrow: false, ..StringWidthOptions::default() }), 2);
}

const SAMPLES: [&str; 6] = [
    "the quick brown fox jumps over the lazy dog",
    "\u{d55c}\u{ae00}\u{c744} \u{c4f4}\u{b2e4} wide \u{4e2d}\u{6587} text",
    "\x1b[31mred words that run over\x1b[39m and plain ones",
    "supercalifragilisticexpialidocious",
    "emoji \u{1f600}\u{1f600}\u{1f600} in the middle",
    "a\tb  c   d",
];

#[test]
fn hard_wrapping_never_exceeds_the_width_and_keeps_every_visible_character() {
    for columns in [1_usize, 2, 3, 10, 20] {
        for text in SAMPLES {
            let wrapped = wrap_ansi(text, columns, WrapOptions { hard: true, ..WrapOptions::default() });
            for row in wrapped.split('\n') {
                let cells = width(row);
                assert!(cells <= columns.max(2), "{cells} cells in {row:?} at {columns} columns");
            }
            let squeeze = |s: &str| strip_ansi(s).chars().filter(|c| !c.is_whitespace()).collect::<String>();
            assert_eq!(squeeze(&wrapped), squeeze(text), "text lost wrapping {text:?} at {columns}");
        }
    }
}

#[test]
fn words_wrap_at_spaces_and_a_long_word_stays_whole_without_hard() {
    assert_eq!(wrap_ansi("hello world", 5, WrapOptions::default()), "hello\nworld");
    assert_eq!(wrap_ansi("abcdefghij", 4, WrapOptions::default()), "abcdefghij");
    assert_eq!(wrap_ansi("abcdefghij", 4, WrapOptions { hard: true, ..WrapOptions::default() }), "abcd\nefgh\nij");
}

#[test]
fn a_wrapped_style_is_closed_and_reopened_on_every_row() {
    let wrapped = wrap_ansi("\x1b[31mabcdef\x1b[39m", 3, WrapOptions { hard: true, ..WrapOptions::default() });
    assert_eq!(wrapped, "\x1b[31mabc\x1b[39m\n\x1b[31mdef\x1b[39m");
}

#[test]
fn a_slice_is_cut_by_cells_never_through_a_wide_character_and_keeps_styles_balanced() {
    assert_eq!(slice_ansi("abcdef", 1, Some(4)), "bcd");
    assert_eq!(slice_ansi("\u{4e2d}\u{6587}\u{5b57}", 0, Some(3)), "\u{4e2d}", "the second wide character does not fit in the third cell");
    assert_eq!(slice_ansi("\x1b[31mabcdef\x1b[39m", 1, Some(3)), "\x1b[31mbc\x1b[39m");
}

#[test]
fn truncation_fits_the_budget_with_an_ellipsis_at_the_chosen_end() {
    assert_eq!(truncate("hello world", 20, TruncatePosition::End), "hello world");
    assert_eq!(truncate("hello world", 8, TruncatePosition::End), "hello w\u{2026}");
    assert_eq!(truncate("hello world", 8, TruncatePosition::Start), "\u{2026}o world");
    assert_eq!(truncate("hello world", 8, TruncatePosition::Middle), "hell\u{2026}rld");
    assert_eq!(truncate("hello world", 0, TruncatePosition::End), "");
    for columns in 1..12 {
        for position in [TruncatePosition::Start, TruncatePosition::Middle, TruncatePosition::End] {
            assert!(width(&truncate("\u{d55c}\u{ae00} hello \u{4e2d}", columns, position)) <= columns);
        }
    }
}
