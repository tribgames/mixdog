//! The text rules of `format-token.mjs`: entity decoding, the repair of a strong run that CommonMark leaves open next to
//! natural-language text, and raw HTML.

use std::sync::LazyLock;

use mixdog_js::js_trim;

use super::colors::bold;
use crate::lexer::Token;
use crate::lexer::rules::Re;

/// Replaces the `&#digits;` (`hex` false) or `&#xhex;` (`hex` true) references `convert` accepts; the others stay.
fn replace_numeric_references(text: &str, hex: bool, convert: impl Fn(&str) -> Option<String>) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while let Some(found) = text[at..].find("&#") {
        let start = at + found;
        let mut end = start + 2;
        if hex {
            if matches!(bytes.get(end), Some(b'x' | b'X')) {
                end += 1;
            } else {
                at = start + 1;
                continue;
            }
        }
        let digits = end;
        while bytes.get(end).is_some_and(|b| if hex { b.is_ascii_hexdigit() } else { b.is_ascii_digit() }) {
            end += 1;
        }
        if end > digits
            && bytes.get(end) == Some(&b';')
            && let Some(replacement) = convert(&text[digits..end])
        {
            out.push_str(&text[copied..start]);
            out.push_str(&replacement);
            copied = end + 1;
            at = end + 1;
            continue;
        }
        at = start + 1;
    }
    out.push_str(&text[copied..]);
    out
}

/// `String.fromCodePoint(n)`: a surrogate becomes U+FFFD (a Rust string cannot hold one); a number past U+10FFFF, which
/// throws in Node, leaves the reference as it is.
fn code_point(parsed: Option<u64>) -> Option<String> {
    let value = u32::try_from(parsed?).ok()?;
    if (0xd800..=0xdfff).contains(&value) {
        return Some('\u{fffd}'.to_string());
    }
    char::from_u32(value).map(String::from)
}

/// `decodeEntities(s)`: marked HTML-encodes `text`; a terminal wants the literals back. The named set marked emits and
/// numeric references are decoded; `&amp;` goes last so `&amp;lt;` becomes `&lt;` and not `<`.
pub(super) fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let quoted = text.replace("&quot;", "\"");
    let apostrophes = replace_numeric_references(&quoted, false, |digits| {
        (digits.trim_start_matches('0') == "39").then(|| "'".to_owned())
    });
    let named = apostrophes.replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">");
    let decimal = replace_numeric_references(&named, false, |digits| code_point(digits.parse().ok()));
    let hexadecimal =
        replace_numeric_references(&decimal, true, |digits| code_point(u64::from_str_radix(digits, 16).ok()));
    hexadecimal.replace("&amp;", "&")
}

/// `ADJACENT_STRONG_RE`: CommonMark refuses to close `**0.118%**이며` or `**A.**B` (punctuation before the closing
/// delimiter, a letter after it), so the markers would stay visible as literal text.
static ADJACENT_STRONG: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        r"(?:\*\*(?!\s)([^*\n]*?[^\s\p{L}\p{N}*])\*\*|__(?!\s)([^_\n]*?[^\s\p{L}\p{N}_])__)(?=[\p{L}\p{N}])",
        "u",
    )
});

/// `repairAdjacentStrong(text)`.
pub(super) fn repair_adjacent_strong(text: &str) -> String {
    if !text.contains("**") && !text.contains("__") {
        return text.to_owned();
    }
    ADJACENT_STRONG.replace_all(text, |caps| bold(caps.get(1).or_else(|| caps.get(2)).unwrap_or("")))
}

static HTML_COMMENT_ONLY: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*<!--[\s\S]*?-->\s*$", ""));
static HTML_COMMENT: LazyLock<Re> = LazyLock::new(|| Re::new(r"<!--[\s\S]*?-->", ""));

/// `renderHtmlToken(token)`: raw HTML shown verbatim; only comments, never meant to be read, are dropped.
pub(super) fn render_html(token: &Token) -> String {
    let raw = decode_entities(&token.raw);
    if js_trim(&raw).is_empty() || HTML_COMMENT_ONLY.test(&raw) {
        return String::new();
    }
    HTML_COMMENT.replace_all(&raw, |_| String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_decode_in_the_order_node_does() {
        assert_eq!(decode_entities("a &quot;b&quot; &#39;c&#039; &lt;d&gt; &amp; &#65;&#x42;&#X43;"), "a \"b\" 'c' <d> & ABC");
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_entities("&#38;#x41;"), "A");
        assert_eq!(decode_entities("&#12 &#;&#x; &#99999999999;"), "&#12 &#;&#x; &#99999999999;");
        assert_eq!(decode_entities("no entities"), "no entities");
    }

    #[test]
    fn a_strong_run_next_to_a_letter_is_repaired() {
        assert_eq!(repair_adjacent_strong("**0.118%**tail"), "\u{1b}[1m0.118%\u{1b}[22mtail");
        assert_eq!(repair_adjacent_strong("__A.__B"), "\u{1b}[1mA.\u{1b}[22mB");
        assert_eq!(repair_adjacent_strong("**word** tail"), "**word** tail");
        assert_eq!(repair_adjacent_strong("plain"), "plain");
    }

    #[test]
    fn raw_html_keeps_its_markup_and_loses_its_comments() {
        let html = |raw: &str| render_html(&Token::new(crate::lexer::TokenKind::Html, raw));
        assert_eq!(html("<b>x</b>"), "<b>x</b>");
        assert_eq!(html("  <!-- hidden -->\n"), "");
        assert_eq!(html("<p>a<!-- c -->b</p>"), "<p>ab</p>");
        assert_eq!(html("  \n"), "");
        assert_eq!(html("&lt;i&gt;"), "<i>");
    }
}
