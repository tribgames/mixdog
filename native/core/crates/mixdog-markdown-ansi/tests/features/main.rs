//! What a reader of the rendered markdown sees: the blocks as text at a width, the tables, the streaming split of an
//! unfinished answer, the in-place patch when it finishes, and the plain REPL rendering.

use mixdog_markdown_ansi::measure::{measure_markdown_rendered_rows, wrapped_line_rows};
use mixdog_markdown_ansi::render::render_markdown_ansi;
use mixdog_markdown_ansi::repl_render::render_repl_markdown_with;
use mixdog_markdown_ansi::stream::{build_stream_final_patch, resolve_streaming_markdown_parts, window_plain_streaming_text};
use mixdog_termtext::string_width;
use mixdog_termtext::width::StringWidthOptions;
use mixdog_termtext::strip_ansi;
use mixdog_tui_style::color::Styler;

fn plain_rows(text: &str, columns: usize) -> Vec<String> {
    render_markdown_ansi(text, columns).iter().flat_map(|block| strip_ansi(block).split('\n').map(str::to_owned).collect::<Vec<_>>()).collect()
}

fn cells(text: &str) -> usize {
    string_width(text, StringWidthOptions::default())
}

const DOCUMENT: &str = "# Title\n\nA paragraph with **strong**, *emphasis*, `code` and a [link](https://example.com) that runs long enough to wrap.\n\n- first item\n- second item with more words to wrap around the edge\n  - nested\n\n1. one\n2. two\n\n> quoted text\n\n```js\nconst x = 1;\n```\n\n| name | value |\n| --- | ---: |\n| a | 1 |\n| longer name | 22 |\n\n---\n";

#[test]
fn headings_lists_quotes_and_code_keep_their_words_in_order() {
    let text = plain_rows(DOCUMENT, 60).join("\n");
    let mut at = 0;
    for word in ["Title", "A paragraph with strong", "first item", "second item", "nested", "one", "two", "quoted text", "const x = 1;"] {
        let found = text[at..].find(word).unwrap_or_else(|| panic!("{word:?} missing or out of order in:\n{text}"));
        at += found + word.len();
    }
    assert!(!text.contains("**"), "emphasis markers are consumed");
    assert!(!text.contains("```"), "the fence markers are not shown");
}

#[test]
fn a_link_shows_its_text_and_carries_the_address_as_a_hyperlink() {
    let rendered = render_markdown_ansi("see [the docs](https://example.com/x) now", 80).join("\n");
    assert!(rendered.contains("\x1b]8;;https://example.com/x"), "{rendered:?}");
    assert!(strip_ansi(&rendered).contains("the docs"));
}

#[test]
fn paragraphs_are_left_to_the_terminal_to_wrap_while_tables_and_rules_fit_the_width() {
    for columns in [20_usize, 40, 80] {
        let rows = plain_rows("some words\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n", columns);
        for row in &rows {
            assert!(cells(row) <= columns, "{} cells at {columns}: {row:?}", cells(row));
        }
    }
    let long = "word ".repeat(30);
    assert_eq!(plain_rows(&long, 20).iter().filter(|row| !row.is_empty()).count(), 1, "a paragraph is one logical row");
}

#[test]
fn the_rows_measured_are_the_rows_painted() {
    for columns in [20_usize, 33, 40, 80, 120] {
        let painted: usize = render_markdown_ansi(DOCUMENT, columns)
            .iter()
            .map(|block| block.split('\n').map(|line| wrapped_line_rows(line, columns)).sum::<usize>())
            .sum();
        let measured = measure_markdown_rendered_rows(DOCUMENT, columns, false);
        let blocks = DOCUMENT.matches("\n\n").count();
        assert!(measured >= painted && measured <= painted + blocks + 1, "{measured} measured vs {painted} painted at {columns}");
    }
}
#[test]
fn a_table_that_fits_is_boxed_and_a_narrow_one_falls_back_to_labelled_lines() {
    let wide = plain_rows("| name | value |\n| --- | --- |\n| a | 1 |\n", 80).join("\n");
    assert!(wide.contains('\u{2502}') && wide.contains('\u{2500}'), "a box is drawn:\n{wide}");
    let narrow = plain_rows("| name | value |\n| --- | --- |\n| alpha beta gamma | delta epsilon zeta |\n", 12).join("\n");
    assert!(narrow.contains("name:") && narrow.contains("value:"), "one `Header: value` line per cell:\n{narrow}");
    for row in narrow.split('\n') {
        assert!(cells(row) <= 12, "{row:?}");
    }
}

#[test]
fn rows_are_counted_by_display_width_when_a_line_wraps() {
    assert_eq!(wrapped_line_rows("", 10), 1);
    assert_eq!(wrapped_line_rows("0123456789", 10), 1);
    assert_eq!(wrapped_line_rows("0123456789a", 10), 2);
    assert_eq!(wrapped_line_rows("\u{d55c}\u{ae00}\u{d55c}\u{ae00}\u{d55c}", 4), 3, "wide characters count two cells");
    assert_eq!(wrapped_line_rows("\x1b[31mred\x1b[39m", 3), 1, "escape sequences take no cells");
}

#[test]
fn text_without_markup_is_one_live_tail_and_blocks_settle_behind_the_last_one() {
    let plain = resolve_streaming_markdown_parts("just words so far", None);
    assert!(plain.plain);
    assert_eq!(plain.unstable_suffix, "just words so far");

    let two = resolve_streaming_markdown_parts("# Head\n\nfirst para\n\nsecond para being typed", None);
    assert!(!two.plain);
    assert!(two.stable_prefix.contains("first para"), "{:?}", two.stable_prefix);
    assert!(two.unstable_suffix.contains("second para"), "{:?}", two.unstable_suffix);
    assert!(!two.stable_prefix.contains("second para"));
}

#[test]
fn an_unclosed_fence_is_the_live_tail_and_what_precedes_it_settles() {
    let parts = resolve_streaming_markdown_parts("intro paragraph\n\n```rust\nlet x = 1;\n", None);
    assert!(parts.open_fence);
    assert!(parts.stable_prefix.contains("intro paragraph"));
    assert!(parts.unstable_suffix.contains("let x = 1;"));
    let closed = resolve_streaming_markdown_parts("intro paragraph\n\n```rust\nlet x = 1;\n```\n", None);
    assert!(!closed.open_fence);
}

#[test]
fn a_streamed_plain_text_is_windowed_to_its_last_rows() {
    let text = "one\ntwo\nthree\nfour\nfive";
    let windowed = window_plain_streaming_text(text, 20, 2, None);
    assert!(windowed.ends_with("five"), "{windowed:?}");
    assert!(!windowed.contains("one"), "{windowed:?}");
    assert!(window_plain_streaming_text("short", 20, 5, None).contains("short"));
}

#[test]
fn the_final_patch_rewrites_only_when_rows_map_one_to_one() {
    assert!(build_stream_final_patch("a\nb", "a\nb\nc", 80).is_none(), "a different row count needs a full redraw");
    assert!(build_stream_final_patch("a\r\nb", "a\nb", 80).is_none(), "carriage returns need a full redraw");
    let unchanged = build_stream_final_patch("a\nb", "a\nb", 80).expect("same rows");
    assert_eq!((unchanged.changed_rows, unchanged.total_rows), (0, 2));
    assert!(unchanged.output.is_empty());
    let changed = build_stream_final_patch("a\nb", "a\nB", 80).expect("same row count");
    assert_eq!((changed.changed_rows, changed.total_rows), (1, 2));
    assert!(changed.output.contains('B'));
    let wide = "x".repeat(80);
    assert!(build_stream_final_patch(&wide, &wide, 80).is_none(), "a row as wide as the terminal wraps");
}

#[test]
fn the_repl_rendering_without_colour_is_plain_text_that_fits_the_width() {
    let plain = Styler::new(false, false);
    let out = render_repl_markdown_with("# Title\n\nSome **bold** words and `code`.\n\n- a\n- b\n\n```\nfn x()\n```\n", 40, plain);
    assert!(!out.contains('\x1b'), "{out:?}");
    assert!(out.contains("Title") && out.contains("bold") && out.contains("code") && out.contains("fn x()"), "{out}");
    assert!(!out.contains("**"));
    for row in out.split('\n') {
        assert!(cells(row) <= 40, "{row:?}");
    }
}

#[test]
fn the_repl_rendering_with_colour_wraps_styled_runs_in_escapes() {
    let coloured = render_repl_markdown_with("some **bold** text", 40, Styler::new(true, true));
    assert!(coloured.contains('\x1b'));
    assert_eq!(strip_ansi(&coloured).trim_end(), "some bold text");
}
