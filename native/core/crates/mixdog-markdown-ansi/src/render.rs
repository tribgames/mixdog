//! The entry points of the markdown renderer (`render-ansi.mjs`): the lexer step ([`lex_markdown`],
//! [`has_markdown_syntax`]) and the rendered segments of a text ([`render_token_ansi_segments`]), each cached.

use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use mixdog_tui_style::get_theme_version;

use crate::format::{Context, format_token};
use crate::lexer::rules::Re;
use crate::lexer::{Token, TokenKind, lex};
use crate::lru::Lru;
use crate::table::build_table_render;

const TOKEN_CACHE_MAX: usize = 500;
const RENDERED_SEGMENT_CACHE_MAX: usize = 12;
const RENDERED_SEGMENT_CACHE_MAX_CHARS: usize = 256 * 1024;

/// Block/inline syntax probe. Beyond the inline marker class it catches the block forms whose markers are not in that
/// class, or the text renders as a literal paragraph: `+ ` bullets, `1)` ordered items, a setext `===` underline, and
/// 4-space indented code.
static MD_SYNTAX: LazyLock<Re> = LazyLock::new(|| {
    Re::new(r##"[#*`|[>\-_~]|\n\n|(?:^|\n)\d+[.)] |(?:^|\n)\+ |(?:^|\n)={2,}[ \t]*(?:\n|$)|(?:^|\n) {4}\S"##, "")
});

/// The tokens of settled text, by the text (`tokenCache` of `render-ansi.mjs`).
static TOKEN_CACHE: LazyLock<Mutex<Lru<String, Arc<Vec<Token>>>>> = LazyLock::new(|| Mutex::new(Lru::new(TOKEN_CACHE_MAX)));

/// How [`lex_markdown`] reads its text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LexOptions {
    /// The text is the growing tail of a stream: it is lexed fresh and never cached, so the partial closing fence the
    /// streaming step trims cannot reach the cache the settled text shares.
    pub trim_partial_fences: bool,
}

/// `hasMarkdownSyntax(text)`.
pub fn has_markdown_syntax(text: &str) -> bool {
    MD_SYNTAX.test(text)
}

/// `lexMarkdown(content, { trimPartialFences })`: the tokens of `content`. Text with no markdown syntax is one paragraph
/// of one text token.
pub fn lex_markdown(content: &str, options: LexOptions) -> Arc<Vec<Token>> {
    if !has_markdown_syntax(content) {
        let text = Token::with_text(TokenKind::Text, content, content);
        let mut paragraph = Token::with_text(TokenKind::Paragraph, content, content);
        paragraph.tokens = Some(vec![text]);
        return Arc::new(vec![paragraph]);
    }
    if options.trim_partial_fences {
        return Arc::new(crate::stream::lex_streaming_tail(content));
    }
    let hit = TOKEN_CACHE.lock().unwrap_or_else(PoisonError::into_inner).get(content).map(Arc::clone);
    if let Some(hit) = hit {
        return hit;
    }
    let tokens = Arc::new(lex(content).tokens);
    TOKEN_CACHE.lock().unwrap_or_else(PoisonError::into_inner).touch(content.to_owned(), Arc::clone(&tokens));
    tokens
}

/// How [`render_token_ansi_segments`] renders its text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderOptions {
    /// The width of the block; 0 is unknown (a rule then spans 80 columns).
    pub width: usize,
    /// See [`LexOptions::trim_partial_fences`].
    pub trim_partial_fences: bool,
}

/// One block of rendered markdown: a table for the table layout, or the ANSI text of any other token.
#[derive(Clone, Debug)]
pub struct Segment {
    tokens: Arc<Vec<Token>>,
    index: usize,
    ansi: Option<String>,
}

impl Segment {
    /// The token this segment renders.
    pub fn token(&self) -> &Token {
        &self.tokens[self.index]
    }

    /// The ANSI text of a block, with its leading and trailing newlines trimmed; none for a table.
    pub fn ansi(&self) -> Option<&str> {
        self.ansi.as_deref()
    }

    pub fn is_table(&self) -> bool {
        self.ansi.is_none()
    }
}

struct SegmentEntry {
    text: String,
    /// `text.length`: UTF-16 units, as the cache budget counts them.
    units: usize,
    options: RenderOptions,
    theme_version: u64,
    segments: Arc<Vec<Segment>>,
}

/// The rendered segments, the least recently used first, at most 12 of at most 256 KiB of text in all.
static SEGMENT_CACHE: Mutex<Vec<SegmentEntry>> = Mutex::new(Vec::new());

/// `renderTokenAnsiSegments(content, opts)`: the blocks of `content` in order, a table as itself and every other token as
/// `formatToken`'s string; a block that renders to nothing but newlines is dropped. The result is cached by text, width,
/// fence trimming and theme version.
pub fn render_token_ansi_segments(content: &str, options: RenderOptions) -> Arc<Vec<Segment>> {
    let theme_version = get_theme_version();
    {
        let mut cache = SEGMENT_CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        let hit = cache.iter().rposition(|entry| {
            entry.options == options && entry.theme_version == theme_version && entry.text == content
        });
        if let Some(at) = hit {
            let entry = cache.remove(at);
            let segments = Arc::clone(&entry.segments);
            cache.push(entry);
            return segments;
        }
    }
    let tokens = lex_markdown(content, LexOptions { trim_partial_fences: options.trim_partial_fences });
    let context = Context::at_width(options.width);
    let mut segments = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        match token.kind {
            TokenKind::Space => {}
            TokenKind::Table => segments.push(Segment { tokens: Arc::clone(&tokens), index, ansi: None }),
            _ => {
                let rendered = format_token(token, &context);
                let ansi = rendered.trim_matches('\n');
                if !ansi.is_empty() {
                    segments.push(Segment { tokens: Arc::clone(&tokens), index, ansi: Some(ansi.to_owned()) });
                }
            }
        }
    }
    let segments = Arc::new(segments);
    let units = content.encode_utf16().count();
    if units <= RENDERED_SEGMENT_CACHE_MAX_CHARS {
        let mut cache = SEGMENT_CACHE.lock().unwrap_or_else(PoisonError::into_inner);
        cache.push(SegmentEntry {
            text: content.to_owned(),
            units,
            options,
            theme_version,
            segments: Arc::clone(&segments),
        });
        let mut chars: usize = cache.iter().map(|entry| entry.units).sum();
        while cache.len() > RENDERED_SEGMENT_CACHE_MAX || chars > RENDERED_SEGMENT_CACHE_MAX_CHARS {
            let removed = cache.remove(0);
            chars -= removed.units;
        }
    }
    segments
}

/// The rendered lines of `text` as `<Markdown columns>` of `Markdown.jsx` lays them out: the segments at `columns` (80
/// when unknown), a table by the table layout, one blank row between blocks (`gap={1}`).
pub fn render_markdown_ansi(text: &str, columns: usize) -> Vec<String> {
    let width = if columns == 0 { 80 } else { columns };
    let segments = render_token_ansi_segments(text, RenderOptions { width, trim_partial_fences: false });
    let mut lines = Vec::new();
    for (at, segment) in segments.iter().enumerate() {
        if at > 0 {
            lines.push(String::new());
        }
        match segment.ansi() {
            Some(ansi) => lines.extend(ansi.split('\n').map(str::to_owned)),
            None => lines.extend(build_table_render(segment.token(), width)),
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_one_paragraph_and_markup_is_lexed() {
        assert!(!has_markdown_syntax("hello world, nothing here"));
        let plain = lex_markdown("hello world", LexOptions::default());
        assert_eq!(plain.len(), 1);
        assert_eq!(plain[0].kind, TokenKind::Paragraph);
        assert_eq!(plain[0].children().len(), 1);
        for marked in ["# t", "*a*", "`c`", "a|b", "> q", "- x", "a_b", "~~s~~", "x\n\ny", "1) a", "+ a", "t\n==", "    code"] {
            assert!(has_markdown_syntax(marked), "{marked}");
        }
        let lexed = lex_markdown("# t\n", LexOptions::default());
        assert_eq!(lexed[0].kind, TokenKind::Heading);
        assert!(Arc::ptr_eq(&lexed, &lex_markdown("# t\n", LexOptions::default())));
        let fresh = lex_markdown("# t\n", LexOptions { trim_partial_fences: true });
        assert!(!Arc::ptr_eq(&lexed, &fresh));
    }

    const BOLD: &str = "\u{1b}[1m";
    const STRIKE: &str = "\u{1b}[9m";

    /// `tui(text, width)` of `scripts/markdown-surface-test.mjs`: the ANSI of every segment joined by newlines.
    fn tui(text: &str) -> String {
        let segments = render_token_ansi_segments(text, RenderOptions { width: 60, trim_partial_fences: false });
        segments.iter().map(|segment| segment.ansi().unwrap_or("")).collect::<Vec<_>>().join("\n")
    }

    fn tui_text(text: &str) -> String {
        mixdog_termtext::strip_ansi(&tui(text)).into_owned()
    }

    #[test]
    fn strong_closes_against_a_punctuation_and_letter_boundary() {
        let rendered = tui("**0.118%**tail");
        assert!(rendered.contains(BOLD), "expected a bold SGR run");
        assert_eq!(mixdog_termtext::strip_ansi(&rendered), "0.118%tail");
    }

    #[test]
    fn strikethrough_is_pair_only() {
        let struck = tui("~~gone~~ kept");
        assert!(struck.contains(STRIKE), "expected a strikethrough SGR run");
        assert_eq!(mixdog_termtext::strip_ansi(&struck), "gone kept");
        assert!(!tui("1~2 range").contains(STRIKE));
    }

    #[test]
    fn task_boxes_keep_their_state() {
        let rendered = tui_text("- [ ] todo\n- [x] done");
        assert!(rendered.contains("[ ] todo"), "{rendered:?}");
        assert!(rendered.contains("[x] done"), "{rendered:?}");
    }

    #[test]
    fn raw_html_survives_and_comments_do_not() {
        assert!(tui_text("text <b>x</b> end").contains("<b>x</b>"));
        assert_eq!(tui_text("<!-- hidden -->").trim(), "");
    }

    #[test]
    fn images_keep_their_alt_text() {
        let rendered = tui_text("![alt text](https://x.dev/a.png)");
        assert!(rendered.contains("alt text"), "{rendered:?}");
        assert!(rendered.contains("https://x.dev/a.png"), "{rendered:?}");
    }

    #[test]
    fn block_syntax_outside_the_inline_marker_class_is_detected() {
        for source in ["+ a\n+ b", "1) a\n2) b", "Title\n=====", "    indented"] {
            assert!(has_markdown_syntax(source), "expected markdown syntax in {source:?}");
        }
        assert_eq!(tui_text("+ a\n+ b"), "- a\n- b");
        assert!(tui("Title\n=====").contains(BOLD), "setext heading should render bold");
    }

    #[test]
    fn footnote_definitions_stay_visible_and_are_not_linkified() {
        let source = "body[^1]\n\n[^1]: the note";
        assert!(tui_text(source).contains("the note"));
        assert!(!tui(source).contains("\u{1b}]8;;"));
    }

    #[test]
    fn blocks_are_laid_out_one_blank_row_apart_and_an_unknown_width_is_eighty() {
        let lines: Vec<String> = render_markdown_ansi("# a\n\ntext\n\n---\n", 0)
            .iter()
            .map(|line| mixdog_termtext::strip_ansi(line).into_owned())
            .collect();
        let rule = "\u{2500}".repeat(80);
        assert_eq!(lines, ["a", "", "text", "", rule.as_str()]);
    }

    #[test]
    fn segments_are_cached_by_text_width_and_options_and_tables_are_left_to_the_layout() {
        let options = RenderOptions { width: 40, trim_partial_fences: false };
        let first = render_token_ansi_segments("# a\n\ntext\n", options);
        assert!(Arc::ptr_eq(&first, &render_token_ansi_segments("# a\n\ntext\n", options)));
        assert!(!Arc::ptr_eq(&first, &render_token_ansi_segments("# a\n\ntext\n", RenderOptions { width: 41, ..options })));
        assert_eq!(first.len(), 2);
        assert!(first.iter().all(|segment| !segment.is_table()));
        assert!(!first[0].ansi().unwrap_or("").ends_with('\n'));

        let table = render_token_ansi_segments("| a | b |\n| - | - |\n| 1 | 2 |\n", options);
        assert_eq!(table.len(), 1);
        assert!(table[0].is_table());
        assert_eq!(table[0].token().kind, TokenKind::Table);
    }
}
