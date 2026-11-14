//! The `del` tokenizer of `render-ansi.mjs`'s `configureMarked()`. marked's own `del` also accepts a single tilde, which
//! turns approximation prose ("~100", "1~2") into struck text, so the TUI replaces it with a pair-only rule (in step with
//! the desktop's remark-gfm `singleTilde: false`). The replacement returns `undefined` when it does not match, which
//! marked reads as "no token": there is no fall back to the original rule.

use super::token::{Token, TokenKind};
use super::Lexer;

lazy_re!(DEL, r"^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)");

impl Lexer {
    pub(super) fn del(&mut self, src: &str) -> Option<Token> {
        let cap = DEL.exec(src)?;
        let text = cap.get(1).unwrap_or("");
        let children = self.inline_tokens(text);
        let mut token = Token::with_text(TokenKind::Del, cap.whole(), text);
        token.tokens = Some(children);
        Some(token)
    }
}

#[cfg(test)]
mod tests {
    use super::super::lex;
    use super::*;

    #[test]
    fn only_a_pair_of_tildes_strikes() {
        let struck = lex("a ~~b~~ c").tokens;
        let inline = struck[0].children();
        assert_eq!(inline[1].kind, TokenKind::Del);
        assert_eq!(inline[1].text.as_deref(), Some("b"));
        for text in ["~b~", "~~ b~~", "~~b ~~", "~~~b~~~"] {
            let tokens = lex(text).tokens;
            assert!(tokens[0].children().iter().all(|t| t.kind != TokenKind::Del), "{text}");
        }
    }
}
