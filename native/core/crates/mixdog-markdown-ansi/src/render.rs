//! The entry points of the markdown renderer. The lexer step is here ([`lex_markdown`], [`has_markdown_syntax`]);
//! `render_markdown_ansi` is filled by the task that ports `format-token.mjs`.

use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use crate::lexer::rules::Re;
use crate::lexer::{Token, TokenKind, lex};
use crate::lru::Lru;

const TOKEN_CACHE_MAX: usize = 500;

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
        return Arc::new(lex(content).tokens);
    }
    let hit = TOKEN_CACHE.lock().unwrap_or_else(PoisonError::into_inner).get(content).map(Arc::clone);
    if let Some(hit) = hit {
        return hit;
    }
    let tokens = Arc::new(lex(content).tokens);
    TOKEN_CACHE.lock().unwrap_or_else(PoisonError::into_inner).touch(content.to_owned(), Arc::clone(&tokens));
    tokens
}

/// `renderMarkdownAnsi(text, columns)`: the rendered lines of `text`.
pub fn render_markdown_ansi(_text: &str, _columns: usize) -> Vec<String> {
    unimplemented!("filled by nr-tui-md-format")
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
}
