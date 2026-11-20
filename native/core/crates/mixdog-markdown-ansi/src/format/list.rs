//! Lists of `format-token.mjs`: the marker of an item (a bullet, or a number that is a letter or a roman numeral at the
//! deeper levels), GFM task boxes, continuation indentation and nested lists.

use mixdog_js::js_trim_end;
use mixdog_termtext::strip_ansi;

use super::colors::{dim, styles};
use super::{Context, content_width_after_prefix, format_token};
use crate::lexer::{Token, TokenKind};

const ROMAN_VALUES: [(u64, &str); 13] =
    [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")];

fn number_to_letter(mut n: u64) -> String {
    let mut letters = Vec::new();
    while n > 0 {
        n -= 1;
        letters.push(char::from(b'a' + (n % 26) as u8));
        n /= 26;
    }
    letters.iter().rev().collect()
}

fn number_to_roman(mut n: u64) -> String {
    let mut result = String::new();
    for (value, numeral) in ROMAN_VALUES {
        while n >= value {
            result.push_str(numeral);
            n -= value;
        }
    }
    result
}

/// `getListNumber(depth, orderedListNumber)`: a number at the top two levels, then letters, then roman numerals.
pub(super) fn list_number(depth: usize, ordered_list_number: u64) -> String {
    match depth {
        2 => number_to_letter(ordered_list_number),
        3 => number_to_roman(ordered_list_number),
        _ => ordered_list_number.to_string(),
    }
}

fn trim_trailing_eol(value: &str) -> &str {
    value.trim_end_matches('\n')
}

fn prefix_lines(value: &str, prefix: &str) -> String {
    value.split('\n').map(|line| format!("{prefix}{line}")).collect::<Vec<_>>().join("\n")
}

fn prefix_first_and_rest(value: &str, first_prefix: &str, rest_prefix: &str) -> String {
    let mut lines = value.split('\n');
    let first = format!("{first_prefix}{}", lines.next().unwrap_or(""));
    std::iter::once(first).chain(lines.map(|line| format!("{rest_prefix}{line}"))).collect::<Vec<_>>().join("\n")
}

/// `formatListItem(token, listBaseIndent, orderedListNumber, depth, width)`.
pub(super) fn format_list_item(token: &Token, ctx: &Context<'_>) -> String {
    let marker_plain = match ctx.ordered_number {
        None => "-".to_owned(),
        Some(number) => format!("{}.", list_number(ctx.depth, number)),
    };
    let marker = styles().base.list_bullet.apply(&marker_plain);
    // A GFM task item: `[ ]`/`[x]` is the item's meaning. marked strips the checkbox from the item text, so without
    // re-emitting it a done and a pending item would render identically.
    let checkbox_mark = if token.checked == Some(true) { "[x] " } else { "[ ] " };
    let checkbox = if token.task == Some(true) { dim(checkbox_mark) } else { String::new() };
    let marker_prefix = format!("{}{marker} {checkbox}", " ".repeat(ctx.list_base_indent));
    let continuation_prefix = " ".repeat(strip_ansi(&marker_prefix).encode_utf16().count());
    let nested_list_indent = continuation_prefix.len();
    let child_width = content_width_after_prefix(ctx.width, &continuation_prefix, ctx.wide);
    let mut out = String::new();
    let mut first_block = true;

    for child in token.children() {
        if child.kind == TokenKind::Space {
            if !first_block {
                out.push_str(&continuation_prefix);
                out.push('\n');
            }
            continue;
        }

        if child.kind == TokenKind::List {
            if first_block {
                out.push_str(js_trim_end(&marker_prefix));
                out.push('\n');
                first_block = false;
            }
            // The outer width is passed on, so the nested list subtracts only its own marker prefix once.
            out.push_str(&format_token(child, &ctx.derive(nested_list_indent, None, Some(token), ctx.width, ctx.depth + 1)));
            continue;
        }

        let rendered = format_token(child, &ctx.derive(ctx.list_base_indent, ctx.ordered_number, Some(token), child_width, ctx.depth));
        let body = trim_trailing_eol(&rendered);
        if body.is_empty() {
            continue;
        }

        if first_block {
            out.push_str(&prefix_first_and_rest(body, &marker_prefix, &continuation_prefix));
            first_block = false;
        } else {
            out.push_str(&prefix_lines(body, &continuation_prefix));
        }
        out.push('\n');
    }

    if first_block {
        return format!("{}\n", js_trim_end(&marker_prefix));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_become_letters_and_roman_numerals_at_depth() {
        assert_eq!(list_number(0, 3), "3");
        assert_eq!(list_number(1, 12), "12");
        assert_eq!(list_number(2, 1), "a");
        assert_eq!(list_number(2, 26), "z");
        assert_eq!(list_number(2, 27), "aa");
        assert_eq!(list_number(3, 4), "iv");
        assert_eq!(list_number(3, 1994), "mcmxciv");
        assert_eq!(list_number(4, 5), "5");
    }
}
