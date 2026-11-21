//! Token to ANSI (`src/tui/markdown/format-token.mjs`): one marked token as the string the transcript draws.
//!
//! Colours come from the active theme ([`colors`]); every SGR sequence is the truecolor byte form chalk writes, whatever
//! the terminal. Tables are not handled here (the table layout draws them). Links to a safe scheme are OSC 8
//! hyperlinks terminated by BEL; anything else, such as a footnote reference, stays plain text.

mod code;
mod colors;
mod list;
mod text;

use std::sync::OnceLock;

use mixdog_js::js_trim;
use mixdog_termtext::{display_width, display_width_with, strip_ansi};
use mixdog_tui_style::figures::{BLOCKQUOTE_BAR, HR_LINE};

pub use code::{colorize_diff_line, highlight_code_block_to_lines, highlight_code_line, lang_family, looks_like_unified_diff};
pub use colors::{Colorizers, ExtraColorizers, Styles, styles};

use colors::{bold, bold_italic, bold_underline, dim, dim_italic, italic, strikethrough};
use text::{decode_entities, render_html, repair_adjacent_strong};

use crate::lexer::{Align, ListStart, Token, TokenKind};

/// The remaining arguments of `formatToken(token, listBaseIndent, orderedListNumber, parent, width, depth)`.
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    /// Columns of indentation of a list item's marker.
    pub list_base_indent: usize,
    /// The number an ordered list item carries, none for a bullet.
    pub ordered_number: Option<u64>,
    pub parent: Option<&'a Token>,
    /// The width the token renders at; 0 is unknown (a rule then spans 80 columns).
    pub width: usize,
    /// The nesting depth of lists.
    pub depth: usize,
    /// The display-width policy (ambiguous arrows and enclosed digits two cells wide): the one of this process, unless a
    /// test fixes it.
    pub wide: bool,
}

/// The display-width policy of this process (`displayWidth`'s): the arrow U+2194 is widened exactly when it is on.
pub fn process_wide() -> bool {
    static WIDE: OnceLock<bool> = OnceLock::new();
    *WIDE.get_or_init(|| display_width("\u{2194}") > 1)
}

impl Context<'static> {
    /// `formatToken(token, 0, null, null, width)`: a top-level block at `width` columns.
    pub fn at_width(width: usize) -> Self {
        Self { list_base_indent: 0, ordered_number: None, parent: None, width, depth: 0, wide: process_wide() }
    }
}

impl Default for Context<'static> {
    /// `formatToken(token)`.
    fn default() -> Self {
        Self::at_width(0)
    }
}

impl Context<'_> {
    /// The context of a recursive call.
    fn derive<'x>(&self, list_base_indent: usize, ordered_number: Option<u64>, parent: Option<&'x Token>, width: usize, depth: usize) -> Context<'x> {
        Context { list_base_indent, ordered_number, parent, width, depth, wide: self.wide }
    }
}

/// `formatToken(token, 0, null, null, width)`.
pub fn format_block(token: &Token, width: usize) -> String {
    format_token(token, &Context::at_width(width))
}

/// `contentWidthAfterPrefix(width, prefix)`: the render width less a visible prefix (list marker, quote bar, ...).
fn content_width_after_prefix(width: usize, prefix: &str, wide: bool) -> usize {
    if width == 0 {
        return 0;
    }
    width.saturating_sub(display_width_with(prefix, wide)).max(8)
}

fn format_children(token: &Token, ctx: &Context<'_>) -> String {
    token.children().iter().map(|child| format_token(child, ctx)).collect()
}

const EOL: &str = "\n";

/// A scheme worth handing to the terminal as an OSC 8 target: `^(?:https?|mailto|file|ftp):` in any case.
fn has_safe_link_scheme(href: &str) -> bool {
    let Some(end) = href.find(':') else { return false };
    ["http", "https", "mailto", "file", "ftp"].iter().any(|scheme| href[..end].eq_ignore_ascii_case(scheme))
}

fn osc8_link(href: &str, label: &str) -> String {
    format!("\u{1b}]8;;{href}\u{7}{label}\u{1b}]8;;\u{7}")
}

fn format_blockquote(token: &Token, ctx: &Context<'_>) -> String {
    // Block structure carries no colour: a dim bar and body-coloured italic text. Colour is reserved for inline
    // codespans and links.
    let bar = dim(BLOCKQUOTE_BAR);
    let quote_prefix = format!("{BLOCKQUOTE_BAR} ");
    let inner_width = content_width_after_prefix(ctx.width, &quote_prefix, ctx.wide);
    let inner = format_children(token, &ctx.derive(0, None, None, inner_width, 0));
    inner
        .split(EOL)
        .map(|line| {
            // Padded fenced-code blank rows are space-only; trimming would drop the quote bar.
            if display_width_with(&strip_ansi(line), ctx.wide) == 0 { line.to_owned() } else { format!("{bar} {}", italic(line)) }
        })
        .collect::<Vec<_>>()
        .join(EOL)
}

fn format_image(token: &Token) -> String {
    let ex = &styles().extra;
    // The alt text is the only description a terminal reader gets.
    let alt_text = decode_entities(token.text_str());
    let alt = js_trim(&alt_text);
    let href = token.href.as_deref().unwrap_or("");
    if alt.is_empty() {
        ex.link.apply(href)
    } else if href.is_empty() {
        ex.link_text.apply(alt)
    } else {
        format!("{} {}", ex.link_text.apply(alt), dim(&format!("({href})")))
    }
}

fn format_link(token: &Token, ctx: &Context<'_>) -> String {
    let ex = &styles().extra;
    let href = token.href.as_deref().unwrap_or("");
    if let Some(address) = href.strip_prefix("mailto:") {
        return ex.link_text.apply(address);
    }
    let label_ctx = ctx.derive(0, None, Some(token), 0, 0);
    if !has_safe_link_scheme(href) {
        // Footnote references and other non-URL targets must not reach the terminal as a hyperlink destination.
        let label = format_children(token, &label_ctx);
        return ex.link_text.apply(if label.is_empty() { href } else { label.as_str() });
    }
    let link_text = format_children(token, &label_ctx);
    let plain = strip_ansi(&link_text);
    // An OSC 8 hyperlink: a clickable label with the URL hidden in terminals that support it; the others show
    // the label as is. Only the SGR codes are stripped downstream, so the OSC 8 sequences reach the terminal.
    if !plain.is_empty() && plain != href {
        return osc8_link(href, &ex.link_text.apply(&link_text));
    }
    // No distinct label (empty or equal to the href): the URL is the visible, clickable text.
    osc8_link(href, &ex.link.apply(href))
}

fn format_list(token: &Token, ctx: &Context<'_>) -> String {
    // Loose lists (a blank line between items in the source): items are joined with one extra EOL, so
    // multi-line items keep the author's breathing room. Tight lists render adjacent.
    let ordered = token.ordered == Some(true);
    let start = match token.start {
        Some(ListStart::Number(n)) if n != 0 => n,
        _ => 1,
    };
    let separator = if token.loose == Some(true) && ctx.depth == 0 { EOL } else { "" };
    token
        .items
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let number = ordered.then(|| start + index as u64);
            format_token(item, &ctx.derive(ctx.list_base_indent, number, Some(token), ctx.width, ctx.depth))
        })
        .collect::<Vec<_>>()
        .join(separator)
}
/// `formatToken(token, listBaseIndent, orderedListNumber, parent, width, depth)`: one marked token as an ANSI string.
pub fn format_token(token: &Token, ctx: &Context<'_>) -> String {
    let styles = styles();
    let (accent, hr_line, heading_accent) = (&styles.base.accent, &styles.base.hr_line, &styles.base.heading_accent);
    // `formatToken(t, 0, null, parent)`: the children of emphasis keep the parent of the call.
    let inline = ctx.derive(0, None, ctx.parent, 0, 0);
    match token.kind {
        TokenKind::Blockquote => format_blockquote(token, ctx),
        // A fenced block: flush-left wrapped body with syntax highlighting.
        TokenKind::Code => code::render_code_block(token, ctx.width, ctx.wide),
        // Inline code: the accent colour only, no background tint.
        TokenKind::Codespan => accent.apply(&decode_entities(token.text_str())),
        // Italic only, no colour tint.
        TokenKind::Em => italic(&format_children(token, &inline)),
        // Bold only: body-coloured, just heavier.
        TokenKind::Strong => bold(&format_children(token, &inline)),
        TokenKind::Heading => {
            // A six-level ladder: `strong` is also plain bold, so headings take the theme's heading ink and strong keeps
            // colour-free bold.
            let inner = format_children(token, &ctx.derive(0, None, None, 0, 0));
            match token.depth {
                Some(1) => format!("{}{EOL}{EOL}", bold_underline(&heading_accent.apply(&inner))),
                Some(2) => format!("{}{EOL}{EOL}", bold(&heading_accent.apply(&inner))),
                Some(3) => format!("{}{EOL}{EOL}", bold_italic(&inner)),
                // h4 to h6: the quiet tail, dimmed rather than sized.
                _ => format!("{}{EOL}{EOL}", dim_italic(&inner)),
            }
        }
        TokenKind::Hr => {
            // The available content width with a box-drawing rule; the width is only threaded from the top-level token
            // loop, so a recursive call (0) falls back to an 80 column rule.
            let width = (if ctx.width == 0 { 80 } else { ctx.width }).max(3);
            format!("{}{EOL}", hr_line.apply(&HR_LINE.repeat(width)))
        }
        TokenKind::Image => format_image(token),
        TokenKind::Link => format_link(token, ctx),
        TokenKind::List => format_list(token, ctx),
        TokenKind::ListItem => list::format_list_item(token, ctx),
        TokenKind::Paragraph => {
            let child_ctx = ctx.derive(0, None, None, ctx.width, 0);
            format!("{}{EOL}", format_children(token, &child_ctx))
        }
        TokenKind::Space | TokenKind::Br => EOL.to_owned(),
        TokenKind::Text => {
            if ctx.parent.is_some_and(|parent| parent.kind == TokenKind::Link) {
                return decode_entities(token.text_str());
            }
            if token.tokens.is_some() {
                let child_ctx = ctx.derive(ctx.list_base_indent, ctx.ordered_number, Some(token), ctx.width, ctx.depth);
                return format_children(token, &child_ctx);
            }
            repair_adjacent_strong(&decode_entities(token.text_str()))
        }
        TokenKind::Escape => decode_entities(token.text_str()),
        // GFM strikethrough (pair-only `~~`), the SGR 9 line.
        TokenKind::Del => strikethrough(&format_children(token, &inline)),
        TokenKind::Html => render_html(token),
        // A table is drawn by the table layout.
        TokenKind::Table => String::new(),
    }
}

/// `padAligned(content, displayWidth, targetWidth, align)`: `content` padded with spaces to `target_width` per alignment;
/// `display_width` is its visible width (escape codes excluded).
pub fn pad_aligned(content: &str, display_width: usize, target_width: usize, align: Option<Align>) -> String {
    let padding = target_width.saturating_sub(display_width);
    match align {
        Some(Align::Center) => {
            let left = padding / 2;
            format!("{}{content}{}", " ".repeat(left), " ".repeat(padding - left))
        }
        Some(Align::Right) => format!("{}{content}", " ".repeat(padding)),
        _ => format!("{content}{}", " ".repeat(padding)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_token(text: &str) -> Token {
        let mut token = Token::new(TokenKind::Text, text);
        token.text = Some(text.to_owned());
        token
    }

    fn plain(token: &Token) -> String {
        strip_ansi(&format_token(token, &Context::default())).into_owned()
    }

    #[test]
    fn diff_detection_accepts_hunk_prefixes_but_still_requires_signed_body_lines() {
        let cases = [
            ("@@ -1 +1 @@\n-old\n+new", true),
            ("@@ incomplete\n+new", true),
            ("@@\n+new", false),
            ("@@ -1 +1 @@\n context", false),
            ("+++ b/file\n+new", true),
            ("-old\n+new", false),
            (" file.mjs | 2 +-", true),
            (" image.png | Bin 0 -> 10 bytes", true),
            (" 1 file changed, 1 insertion(+)", true),
        ];
        for (text, expected) in cases {
            assert_eq!(looks_like_unified_diff(text), expected, "{text}");
        }
    }

    #[test]
    fn list_items_keep_first_line_markers_continuation_indentation_and_empty_items() {
        for (text, expected) in [("first\nsecond", "- first\n  second\n"), ("\nnext", "- \n  next\n"), ("", "-\n")] {
            let mut item = Token::new(TokenKind::ListItem, "");
            item.tokens = Some(vec![text_token(text)]);
            assert_eq!(plain(&item), expected, "{text:?}");
        }
    }

    #[test]
    fn safe_link_schemes_are_matched_in_any_case() {
        for href in ["https://x.dev", "HTTP://x", "mailto:a@b", "File:///x", "ftp://x"] {
            assert!(has_safe_link_scheme(href), "{href}");
        }
        for href in ["#^1", "javascript:alert(1)", "data:text/plain,x", "x.dev", ":x", ""] {
            assert!(!has_safe_link_scheme(href), "{href}");
        }
    }

    #[test]
    fn padding_follows_the_alignment() {
        assert_eq!(pad_aligned("ab", 2, 7, None), "ab     ");
        assert_eq!(pad_aligned("ab", 2, 7, Some(Align::Left)), "ab     ");
        assert_eq!(pad_aligned("ab", 2, 7, Some(Align::Right)), "     ab");
        assert_eq!(pad_aligned("ab", 2, 7, Some(Align::Center)), "  ab   ");
        assert_eq!(pad_aligned("abcdef", 6, 3, Some(Align::Center)), "abcdef");
    }

    #[test]
    fn the_rule_spans_the_width_and_falls_back_to_eighty() {
        let hr = Token::new(TokenKind::Hr, "---");
        assert_eq!(strip_ansi(&format_block(&hr, 12)), format!("{}\n", HR_LINE.repeat(12)));
        assert_eq!(strip_ansi(&format_block(&hr, 0)), format!("{}\n", HR_LINE.repeat(80)));
        assert_eq!(strip_ansi(&format_block(&hr, 1)), format!("{}\n", HR_LINE.repeat(3)));
    }

    #[test]
    fn a_link_is_an_osc8_hyperlink_with_a_bel_terminator() {
        let mut link = Token::new(TokenKind::Link, "[docs](https://x.dev)");
        link.href = Some("https://x.dev".to_owned());
        link.tokens = Some(vec![text_token("docs")]);
        let rendered = format_block(&link, 0);
        assert!(rendered.starts_with("\u{1b}]8;;https://x.dev\u{7}"), "{rendered:?}");
        assert!(rendered.ends_with("\u{1b}]8;;\u{7}"), "{rendered:?}");
        assert_eq!(strip_ansi(&rendered).as_ref(), "docs");

        link.href = Some("#^1".to_owned());
        assert!(!format_block(&link, 0).contains("\u{1b}]8;;"));
    }
}
